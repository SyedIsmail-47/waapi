import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { BuiltApp } from "./app.js";

describe("WP-F billing enforcement", () => {
  let app: BuiltApp;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.DEV_RETURN_TOKENS = "true";
    process.env.SIGNUPS_MODE = "open";
    process.env.BILLING_PROVIDER = "manual";
    process.env.TRIAL_DAYS = "3";
    const { buildApp } = await import("./app.js");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function registerLogin(label: string) {
    const email = `${label}-${crypto.randomUUID()}@example.test`;
    const password = "correct-horse-battery-staple";
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password, name: label, acceptTerms: true },
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
    return {
      accountId: body.accountId,
      accessToken: login.json<{ accessToken: string }>().accessToken,
    };
  }

  it("GET /billing returns trial snapshot; checkout falls back to contact support", async () => {
    const auth = await registerLogin("bill-get");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/billing",
      headers: { authorization: `Bearer ${auth.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const snap = res.json<{ status: string; planCode: string; contactToUpgrade: boolean }>();
    expect(snap.planCode).toBe("trial");
    expect(snap.status).toBe("trialing");

    const checkout = await app.inject({
      method: "POST",
      url: "/api/v1/billing/checkout",
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: { planCode: "starter" },
    });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json<{ contactSupport: boolean }>().contactSupport).toBe(true);
  });

  it("expired subscription returns 402 on create session", async () => {
    const auth = await registerLogin("bill-402");
    const { subscriptions } = await import("@waapi/db");
    const updated = await app.database.db
      .update(subscriptions)
      .set({ status: "expired", updatedAt: new Date(), trialEndsAt: new Date(0) })
      .where(eq(subscriptions.accountId, auth.accountId))
      .returning({ status: subscriptions.status });
    expect(updated).toHaveLength(1);
    expect(updated[0]?.status).toBe("expired");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: { name: "blocked" },
    });
    expect(created.statusCode).toBe(402);
    expect(created.json().error.code).toBe("BILLING_EXPIRED");
  });

  it("billing GET requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/billing" });
    expect([401, 403]).toContain(res.statusCode);
  });
});
