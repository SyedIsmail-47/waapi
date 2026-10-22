import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuiltApp } from "./app.js";
import type { FastifyInstance } from "fastify";

describe("WP-G admin ops", () => {
  let app: BuiltApp;
  let internal: FastifyInstance;
  let secret: string;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.DEV_RETURN_TOKENS = "true";
    process.env.SIGNUPS_MODE = "open";
    secret = process.env.ADMIN_API_SECRET!;
    const { buildApp, buildInternalApp } = await import("./app.js");
    app = await buildApp();
    internal = await buildInternalApp(app.database);
    await app.ready();
    await internal.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([app?.close(), internal?.close()]);
  });

  async function register(label: string) {
    const email = `${label}-${crypto.randomUUID()}@example.test`;
    const password = "correct-horse-battery-staple";
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {email, password, name: label, acceptTerms: true},
    });
    const body = reg.json<{ accountId: string; userId: string; verificationToken?: string }>();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      payload: { token: body.verificationToken },
    });
    return { ...body, email, password };
  }

  it("find-user / suspend / set-plan / create-invite are audit-safe", async () => {
    const user = await register("admin-ops");
    const found = await internal.inject({
      method: "GET",
      url: `/internal/admin/users?q=${encodeURIComponent(user.email)}`,
      headers: { "x-admin-secret": secret },
    });
    expect(found.statusCode).toBe(200);
    const list = found.json<{ items: Array<{ email: string }> }>();
    expect(list.items.some((i) => i.email === user.email)).toBe(true);
    expect(JSON.stringify(list)).not.toMatch(/password|token|ciphertext|bodyText/i);

    const suspend = await internal.inject({
      method: "POST",
      url: `/internal/admin/accounts/${user.accountId}/suspend`,
      headers: { "x-admin-secret": secret },
    });
    expect(suspend.statusCode).toBe(204);

    const plan = await internal.inject({
      method: "POST",
      url: `/internal/admin/accounts/${user.accountId}/plan`,
      headers: { "x-admin-secret": secret },
      payload: { planCode: "starter" },
    });
    expect(plan.statusCode).toBe(204);

    const invite = await internal.inject({
      method: "POST",
      url: "/internal/admin/invites",
      headers: { "x-admin-secret": secret },
      payload: { expiresInHours: 24 },
    });
    expect(invite.statusCode).toBe(201);
    expect(invite.json()).toHaveProperty("code");
    expect(invite.json()).not.toHaveProperty("codeHash");
  });

  it("rejects admin routes without secret", async () => {
    const res = await internal.inject({
      method: "GET",
      url: "/internal/admin/users?q=x",
    });
    expect(res.statusCode).toBe(403);
  });
});
