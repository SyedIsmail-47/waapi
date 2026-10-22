import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { BuiltApp } from "../app.js";

describe("WP-N send limits + warm-up", () => {
  let app: BuiltApp;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.DEV_RETURN_TOKENS = "true";
    process.env.SIGNUPS_MODE = "open";
    process.env.TURNSTILE_DISABLED = "true";
    process.env.BILLING_PROVIDER = "manual";
    const { buildApp } = await import("../app.js");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("returns 429 SESSION_SEND_LIMIT with Retry-After when minute cap exceeded", async () => {
    const email = `sendlim-${crypto.randomUUID()}@example.test`;
    const password = "correct-horse-battery-staple";
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password, name: "lim", acceptTerms: true },
    });
    const body = reg.json<{ accountId: string; verificationToken?: string }>();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      payload: { token: body.verificationToken },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password },
    });
    const jwt = login.json<{ accessToken: string }>().accessToken;

    const { sessions } = await import("@waapi/db");
    // Warm-up minute cap is 3 — create connected session with recent createdAt
    const [sess] = await app.database.db
      .insert(sessions)
      .values({
        accountId: body.accountId,
        name: "lim-sess",
        status: "connected",
      })
      .returning();

    let lastStatus = 0;
    let lastCode = "";
    let retryAfter: string | number | string[] | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/send-message",
        headers: {
          authorization: `Bearer ${jwt}`,
          "idempotency-key": `lim-${i}-${crypto.randomUUID()}`,
        },
        payload: { sessionId: sess!.id, to: "+14155552671", text: `msg-${i}` },
      });
      lastStatus = res.statusCode;
      if (res.statusCode === 429) {
        lastCode = res.json().error.code;
        retryAfter = res.headers["retry-after"];
        break;
      }
      expect(res.statusCode, JSON.stringify(res.json())).toBe(202);
    }
    expect(lastStatus).toBe(429);
    expect(lastCode).toBe("SESSION_SEND_LIMIT");
    expect(Number(retryAfter)).toBeGreaterThan(0);

    await app.database.db.delete(sessions).where(eq(sessions.id, sess!.id));
  });
});
