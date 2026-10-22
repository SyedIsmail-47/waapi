import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@waapi/db";
import { processBillingEvent } from "./index.js";
import { paddleProvider } from "./paddle-provider.js";

describe("WP-F paddle webhook replay", () => {
  let database: Db;
  const secret = "paddle-test-webhook-secret-32chars!!";

  beforeAll(async () => {
    process.env.BILLING_PROVIDER = "paddle";
    process.env.PADDLE_WEBHOOK_SECRET = secret;
    process.env.PADDLE_API_KEY = "paddle_test_key";
    process.env.SIGNUPS_MODE = "open";
    process.env.DEV_RETURN_TOKENS = "true";
    const { createDb } = await import("@waapi/db");
    database = createDb(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await database?.client.end();
  });

  function sign(body: string) {
    const ts = String(Math.floor(Date.now() / 1000));
    const h1 = createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
    return `ts=${ts};h1=${h1}`;
  }

  it("processes once and ignores replay", async () => {
    const accountId = crypto.randomUUID();
    // Minimal account row
    const { accounts } = await import("@waapi/db");
    await database.db.insert(accounts).values({ id: accountId, name: "billing-replay" });
    const { ensureSubscription } = await import("./index.js");
    await ensureSubscription(database, accountId);

    const raw = JSON.stringify({
      event_id: `evt_${crypto.randomUUID()}`,
      event_type: "subscription.activated",
      data: { custom_data: { accountId, planCode: "starter" } },
    });
    const event = await paddleProvider.verifyWebhook(
      { "paddle-signature": sign(raw) },
      raw,
    );
    const first = await processBillingEvent(database, event);
    expect(first.duplicate).toBe(false);
    const second = await processBillingEvent(database, event);
    expect(second.duplicate).toBe(true);

    const { subscriptions } = await import("@waapi/db");
    const { eq } = await import("drizzle-orm");
    const [sub] = await database.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId));
    expect(sub?.status).toBe("active");
    expect(sub?.planCode).toBe("starter");

    await database.db.delete(accounts).where(eq(accounts.id, accountId));
  });

  it("rejects bad signatures", async () => {
    const raw = "{}";
    const ts = String(Math.floor(Date.now() / 1000));
    await expect(
      paddleProvider.verifyWebhook(
        { "paddle-signature": `ts=${ts};h1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef` },
        raw,
      ),
    ).rejects.toThrow(/signature/i);
  });

  it("rejects stale timestamps", async () => {
    const raw = "{}";
    const ts = String(Math.floor(Date.now() / 1000) - 3600);
    const h1 = createHmac("sha256", secret).update(`${ts}:${raw}`).digest("hex");
    await expect(
      paddleProvider.verifyWebhook({ "paddle-signature": `ts=${ts};h1=${h1}` }, raw),
    ).rejects.toThrow(/stale/i);
  });
});
