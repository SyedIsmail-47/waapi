import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@waapi/db";
import type { BuiltApp } from "./app.js";

/**
 * WP-D: change password (revoke other refresh), resend verify from authed UI,
 * delete account (re-auth, wipe wa_auth, revoke keys/webhooks, delete logs).
 */
describe("WP-D account lifecycle", () => {
  let app: BuiltApp;
  let database: Db;

  beforeAll(async () => {
    await import("dotenv/config");
    process.env.NODE_ENV = "test";
    process.env.DEV_RETURN_TOKENS = "true";
    process.env.SIGNUPS_MODE = "open";
    process.env.TURNSTILE_DISABLED = "true";
    const { buildApp } = await import("./app.js");
    app = await buildApp();
    database = app.database;
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function registerVerifyLogin(label: string) {
    const email = `${label}-${crypto.randomUUID()}@example.test`;
    const password = "correct-horse-battery-staple";
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password, name: label },
    });
    expect(registered.statusCode).toBe(201);
    const body = registered.json<{
      accountId: string;
      userId: string;
      verificationToken?: string;
    }>();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      payload: { token: body.verificationToken },
    });
    const loggedIn = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password },
    });
    expect(loggedIn.statusCode).toBe(200);
    const tokens = loggedIn.json<{ accessToken: string; refreshToken: string }>();
    return { ...body, email, password, ...tokens };
  }

  it("change-password revokes other refresh tokens but keeps current session usable after re-login", async () => {
    const auth = await registerVerifyLogin("chg-pw");
    const secondLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: auth.email, password: auth.password },
    });
    const otherRefresh = secondLogin.json<{ refreshToken: string }>().refreshToken;

    const changed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: {
        currentPassword: auth.password,
        newPassword: "new-correct-horse-battery",
      },
    });
    expect(changed.statusCode).toBe(204);

    const reuseOther = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: otherRefresh },
    });
    expect(reuseOther.statusCode).toBe(401);

    const loginOld = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: auth.email, password: auth.password },
    });
    expect(loginOld.statusCode).toBe(401);

    const loginNew = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: auth.email, password: "new-correct-horse-battery" },
    });
    expect(loginNew.statusCode).toBe(200);
  });

  it("authenticated resend-verification returns 202 for unverified user", async () => {
    const email = `unverified-${crypto.randomUUID()}@example.test`;
    const password = "correct-horse-battery-staple";
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password },
    });
    expect(registered.statusCode).toBe(201);
    // Force-verify skip — login blocked; mint JWT by verifying then clearing verified? 
    // Instead: verify, login, clear emailVerifiedAt, then call authed resend.
    const token = registered.json<{ verificationToken: string }>().verificationToken;
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      payload: { token },
    });
    const loggedIn = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password },
    });
    const access = loggedIn.json<{ accessToken: string }>().accessToken;
    const { users } = await import("@waapi/db");
    const userId = registered.json<{ userId: string }>().userId;
    await database.db.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, userId));

    const resend = await app.inject({
      method: "POST",
      url: "/api/v1/auth/resend-verification",
      headers: { authorization: `Bearer ${access}` },
      payload: {},
    });
    expect(resend.statusCode).toBe(202);
  });

  it("delete-account requires password and wipes wa_auth, keys, webhooks, message logs", async () => {
    const auth = await registerVerifyLogin("del-acct");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: { name: "to-wipe" },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json<{ id: string }>().id;

    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/keys`,
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: { name: "k" },
    });
    await app.inject({
      method: "PUT",
      url: `/api/v1/sessions/${sessionId}/webhook`,
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: { url: "https://example.com/hook" },
    });

    const { waAuthCreds, waAuthKeys, messageLogs, sessionApiKeys, webhookEndpoints } =
      await import("@waapi/db");
    await database.db.insert(waAuthCreds).values({
      sessionId,
      ciphertext: Buffer.from("cred"),
      iv: Buffer.alloc(12),
      authTag: Buffer.alloc(16),
      keyVersion: 1,
    });
    await database.db.insert(waAuthKeys).values({
      sessionId,
      keyType: "app-state-sync-key",
      keyId: "1",
      ciphertext: Buffer.from("key"),
      iv: Buffer.alloc(12),
      authTag: Buffer.alloc(16),
      keyVersion: 1,
    });
    await database.db.insert(messageLogs).values({
      accountId: auth.accountId,
      sessionId,
      direction: "outbound",
      remoteJid: "1@s.whatsapp.net",
      messageId: "m1",
      fromMe: true,
      messageType: "text",
    });

    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/auth/delete-account",
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: { password: "wrong-password-here" },
    });
    expect(bad.statusCode).toBe(401);

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/auth/delete-account",
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: { password: auth.password },
    });
    expect(ok.statusCode).toBe(204);

    const creds = await database.db.select().from(waAuthCreds).where(eq(waAuthCreds.sessionId, sessionId));
    const keys = await database.db.select().from(waAuthKeys).where(eq(waAuthKeys.sessionId, sessionId));
    expect(creds).toHaveLength(0);
    expect(keys).toHaveLength(0);

    const logs = await database.db
      .select()
      .from(messageLogs)
      .where(eq(messageLogs.accountId, auth.accountId));
    expect(logs).toHaveLength(0);

    const apiKeys = await database.db
      .select()
      .from(sessionApiKeys)
      .where(eq(sessionApiKeys.sessionId, sessionId));
    expect(apiKeys).toHaveLength(0);

    const hooks = await database.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.sessionId, sessionId));
    expect(hooks).toHaveLength(0);

    const loginGone = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: auth.email, password: auth.password },
    });
    expect(loginGone.statusCode).toBe(401);
  });

  it("delete-account is not usable cross-tenant (account B token cannot delete A via id)", async () => {
    // Route is self-only; ensure no accountId param leak — matrix covers auth.
    const [a, b] = await Promise.all([
      registerVerifyLogin("del-a"),
      registerVerifyLogin("del-b"),
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/delete-account",
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { password: a.password },
    });
    expect(res.statusCode).toBe(401);
    // A still exists
    const still = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(still.statusCode).toBe(200);
  });
});
