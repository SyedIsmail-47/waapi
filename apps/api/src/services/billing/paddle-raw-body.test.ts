import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuiltApp } from "../../app.js";

/**
 * N1: Paddle webhook must verify over exact raw Buffer bytes —
 * fixtures where raw !== JSON.stringify(JSON.parse(raw)).
 */
describe("N1 Paddle raw-body signature", () => {
  let app: BuiltApp;
  const secret = "paddle-n1-webhook-secret-32chars!!";

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.BILLING_PROVIDER = "paddle";
    process.env.PADDLE_WEBHOOK_SECRET = secret;
    process.env.PADDLE_API_KEY = "paddle_test_key";
    process.env.PADDLE_PRICE_IDS_JSON = JSON.stringify({
      starter: "pri_starter_allow",
      pro: "pri_pro_allow",
    });
    process.env.SIGNUPS_MODE = "open";
    process.env.DEV_RETURN_TOKENS = "true";
    process.env.TURNSTILE_DISABLED = "true";
    const { buildApp } = await import("../../app.js");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  function signRaw(raw: string | Buffer, ts = Math.floor(Date.now() / 1000), extraH1?: string) {
    const body = typeof raw === "string" ? raw : raw.toString("utf8");
    const h1 = createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
    const parts = [`ts=${ts}`, `h1=${h1}`];
    if (extraH1) parts.push(`h1=${extraH1}`);
    return parts.join(";");
  }

  it("accepts signature over raw bytes that differ from re-stringified JSON", async () => {
    const accountId = crypto.randomUUID();
    const { accounts } = await import("@waapi/db");
    await app.database.db.insert(accounts).values({ id: accountId, name: "n1-raw" });
    const { ensureSubscription } = await import("./index.js");
    await ensureSubscription(app.database, accountId);

    // Extra whitespace + unusual key order — NOT equal to JSON.stringify(JSON.parse(...))
    const raw =
      `{  "event_id" : "evt_n1_${crypto.randomUUID()}" , "event_type":"subscription.activated","data":{ "custom_data" : { "planCode" : "starter" , "accountId":"${accountId}" } , "id":"sub_x", "items":[{"price":{"id":"pri_starter_allow"}}] } }`;
    const parsed = JSON.parse(raw) as object;
    expect(raw).not.toBe(JSON.stringify(parsed));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/billing/webhooks/paddle",
      headers: {
        "content-type": "application/json",
        "paddle-signature": signRaw(raw),
      },
      payload: Buffer.from(raw, "utf8"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, duplicate: false });

    const dup = await app.inject({
      method: "POST",
      url: "/api/v1/billing/webhooks/paddle",
      headers: {
        "content-type": "application/json",
        "paddle-signature": signRaw(raw),
      },
      payload: Buffer.from(raw, "utf8"),
    });
    expect(dup.statusCode).toBe(200);
    expect(dup.json()).toMatchObject({ ok: true, duplicate: true });

    const { eq } = await import("drizzle-orm");
    await app.database.db.delete(accounts).where(eq(accounts.id, accountId));
  });

  it("accepts any matching h1 during secret rotation", async () => {
    const accountId = crypto.randomUUID();
    const { accounts } = await import("@waapi/db");
    await app.database.db.insert(accounts).values({ id: accountId, name: "n1-h1" });
    const { ensureSubscription } = await import("./index.js");
    await ensureSubscription(app.database, accountId);

    const raw = `{"event_id":"evt_rot_${crypto.randomUUID()}","event_type":"subscription.activated","data":{"custom_data":{"accountId":"${accountId}","planCode":"starter"},"items":[{"price":{"id":"pri_starter_allow"}}]}}`;
    const ts = Math.floor(Date.now() / 1000);
    const good = createHmac("sha256", secret).update(`${ts}:${raw}`).digest("hex");
    const bad = "0".repeat(64);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/billing/webhooks/paddle",
      headers: {
        "content-type": "application/json",
        "paddle-signature": `ts=${ts};h1=${bad};h1=${good}`,
      },
      payload: Buffer.from(raw, "utf8"),
    });
    expect(res.statusCode).toBe(200);

    const { eq } = await import("drizzle-orm");
    await app.database.db.delete(accounts).where(eq(accounts.id, accountId));
  });

  it("returns generic 401 on bad signature (no leak)", async () => {
    const raw = `{"event_id":"evt_bad","event_type":"subscription.activated","data":{}}`;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/billing/webhooks/paddle",
      headers: {
        "content-type": "application/json",
        "paddle-signature": signRaw(raw, Math.floor(Date.now() / 1000), undefined).replace(
          /h1=[a-f0-9]+/,
          "h1=" + "ab".repeat(32),
        ),
      },
      payload: Buffer.from(raw, "utf8"),
    });
    // Force wrong h1
    const ts = Math.floor(Date.now() / 1000);
    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/billing/webhooks/paddle",
      headers: {
        "content-type": "application/json",
        "paddle-signature": `ts=${ts};h1=${"cd".repeat(32)}`,
      },
      payload: Buffer.from(raw, "utf8"),
    });
    expect(res2.statusCode).toBe(401);
    const body = JSON.stringify(res2.json());
    expect(body).not.toMatch(/hmac|expected|paddle-n1/i);
    void res;
  });
});
