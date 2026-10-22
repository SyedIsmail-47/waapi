import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@waapi/db";
import type { BuiltApp } from "./app.js";

type AuthSession = {
  accountId: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  email: string;
  password: string;
};

const ACCOUNT_SCOPED_ROUTE_PATTERNS = [
  { method: "GET", url: "/api/v1/sessions/:id" },
  { method: "PATCH", url: "/api/v1/sessions/:id" },
  { method: "DELETE", url: "/api/v1/sessions/:id" },
  { method: "GET", url: "/api/v1/sessions/:id/status" },
  { method: "POST", url: "/api/v1/sessions/:id/connect" },
  { method: "POST", url: "/api/v1/sessions/:id/disconnect" },
  { method: "POST", url: "/api/v1/sessions/:id/logout" },
  { method: "POST", url: "/api/v1/sessions/:id/keys" },
  { method: "GET", url: "/api/v1/sessions/:id/keys" },
  { method: "DELETE", url: "/api/v1/sessions/:id/keys/:keyId" },
  { method: "PUT", url: "/api/v1/sessions/:id/webhook" },
  { method: "GET", url: "/api/v1/sessions/:id/webhook" },
  { method: "DELETE", url: "/api/v1/sessions/:id/webhook" },
  { method: "POST", url: "/api/v1/sessions/:id/webhook/test" },
  { method: "GET", url: "/api/v1/sessions/:id/webhook/deliveries" },
  { method: "POST", url: "/api/v1/sessions/:id/webhook/deliveries/:deliveryId/replay" },
  { method: "POST", url: "/api/v1/send-message" },
];

function normalizeUrl(url: string): string {
  return url.replace(/:[^/]+/g, (m) => m);
}

describe("Phase 2 API integration", () => {
  let app: BuiltApp;
  let database: Db;
  const accountIds = new Set<string>();

  beforeAll(async () => {
    await import("dotenv/config");
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET ??= "test-jwt-secret-that-is-at-least-32-bytes";
    process.env.WEBHOOK_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");
    process.env.ADMIN_API_SECRET ??= "test-admin-api-secret";
    process.env.AUTH_STATE_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");
    process.env.BRAND_NAME ??= "waapi-test";
    process.env.DEV_RETURN_TOKENS = "true";
    process.env.ALLOW_HTTP_WEBHOOKS = "true";
    process.env.ENABLE_DOCS = "false";

    if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
      throw new Error("DATABASE_URL and REDIS_URL required for Phase 2 integration tests");
    }

    const [{ default: postgres }, { Redis }] = await Promise.all([
      import("postgres"),
      import("ioredis"),
    ]);
    const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 5 });
    const redis = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5_000,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    redis.on("error", () => undefined);
    try {
      await Promise.all([sql`select 1`, redis.connect().then(() => redis.ping())]);
      await Promise.all([sql.end({ timeout: 2 }), redis.quit()]);
    } catch (error) {
      await Promise.allSettled([sql.end({ timeout: 2 }), redis.disconnect()]);
      throw new Error(
        `Postgres/Redis required for Phase 2 tests: ${error instanceof Error ? error.message : error}`,
      );
    }

    const { buildApp } = await import("./app.js");
    app = await buildApp();
    database = app.database;
    await app.ready();
  });

  afterAll(async () => {
    if (!app || !database) return;
    const { accounts } = await import("@waapi/db");
    const { inArray } = await import("drizzle-orm");
    if (accountIds.size) {
      await database.db.delete(accounts).where(inArray(accounts.id, [...accountIds]));
    }
    await app.close();
  });

  async function registerVerifyLogin(label: string): Promise<AuthSession> {
    const email = `${label}-${crypto.randomUUID()}@example.test`;
    const password = "correct-horse-battery-staple";
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password, name: label },
    });
    expect(registered.statusCode).toBe(201);
    const registration = registered.json<{
      accountId: string;
      userId: string;
      verificationToken?: string;
    }>();
    expect(registration.verificationToken).toEqual(expect.any(String));
    accountIds.add(registration.accountId);

    const verified = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      payload: { token: registration.verificationToken },
    });
    expect(verified.statusCode).toBe(204);

    const loggedIn = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password },
    });
    expect(loggedIn.statusCode).toBe(200);
    const tokens = loggedIn.json<{ accessToken: string; refreshToken: string }>();
    return {
      accountId: registration.accountId,
      userId: registration.userId,
      email,
      password,
      ...tokens,
    };
  }

  it("never returns verificationToken when DEV_RETURN_TOKENS is false", async () => {
    process.env.DEV_RETURN_TOKENS = "false";
    const email = `no-token-${crypto.randomUUID()}@example.test`;
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password: "correct-horse-battery-staple", name: "gated" },
    });
    expect(registered.statusCode).toBe(201);
    const body = registered.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty("verificationToken");
    accountIds.add(body.accountId as string);
    process.env.DEV_RETURN_TOKENS = "true";
  });

  it("never returns verificationToken when NODE_ENV is production", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.DEV_RETURN_TOKENS = "true";
    const email = `prod-token-${crypto.randomUUID()}@example.test`;
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password: "correct-horse-battery-staple", name: "prod" },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json()).not.toHaveProperty("verificationToken");
    accountIds.add(registered.json<{ accountId: string }>().accountId);
    process.env.NODE_ENV = prev;
    process.env.DEV_RETURN_TOKENS = "true";
  });

  it("registers, rotates refresh, revokes family on reuse after grace, logout-all", async () => {
    const { createHash } = await import("node:crypto");
    const { redis } = await import("./services/queues.js");
    const auth = await registerVerifyLogin("auth-flow");
    const rotated = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: auth.refreshToken },
    });
    expect(rotated.statusCode).toBe(200);
    const rotatedTokens = rotated.json<{ accessToken: string; refreshToken: string }>();
    expect(rotatedTokens.refreshToken).not.toBe(auth.refreshToken);

    const graceReuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: auth.refreshToken },
    });
    expect(graceReuse.statusCode).toBe(200);
    expect(graceReuse.json<{ refreshToken: string }>().refreshToken).toBe(
      rotatedTokens.refreshToken,
    );

    const oldHash = createHash("sha256").update(auth.refreshToken).digest("hex");
    await redis.del(`refresh:grace:${oldHash}`);

    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: auth.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe("TOKEN_REVOKED");

    const afterReuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: rotatedTokens.refreshToken },
    });
    expect(afterReuse.statusCode).toBe(401);

    const auth2 = await registerVerifyLogin("auth-flow-2");
    const r1 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: auth2.refreshToken },
    });
    const next = r1.json<{ refreshToken: string }>().refreshToken;
    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout-all",
      headers: { authorization: `Bearer ${r1.json<{ accessToken: string }>().accessToken}` },
    });
    expect(logout.statusCode).toBe(204);
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: next },
    });
    expect(rejected.statusCode).toBe(401);
  });

  it("concurrent refresh of the same token converges via grace (no family kill)", async () => {
    const auth = await registerVerifyLogin("refresh-race");
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({
          method: "POST",
          url: "/api/v1/auth/refresh",
          payload: { refreshToken: auth.refreshToken },
        }),
      ),
    );
    const ok = results.filter((r) => r.statusCode === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.statusCode === 200 || r.statusCode === 401)).toBe(true);
    const tokens = new Set(
      ok.map((r) => r.json<{ refreshToken: string }>().refreshToken),
    );
    // All successful responses share one successor (grace returns the same plaintext).
    expect(tokens.size).toBe(1);
  });

  it("hides account A resources from account B with exactly 404", async () => {
    const [accountA, accountB] = await Promise.all([
      registerVerifyLogin("tenant-a"),
      registerVerifyLogin("tenant-b"),
    ]);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${accountA.accessToken}` },
      payload: { name: "private-session" },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json<{ id: string }>().id;

    const keyCreated = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/keys`,
      headers: { authorization: `Bearer ${accountA.accessToken}` },
      payload: { name: "k1" },
    });
    const keyId = keyCreated.json<{ id: string }>().id;

    const cases: Array<{
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      url: string;
      payload?: Record<string, string>;
      idempotency?: boolean;
    }> = [
      { method: "GET", url: `/api/v1/sessions/${sessionId}` },
      { method: "PATCH", url: `/api/v1/sessions/${sessionId}`, payload: { name: "x" } },
      { method: "GET", url: `/api/v1/sessions/${sessionId}/status` },
      { method: "POST", url: `/api/v1/sessions/${sessionId}/connect` },
      { method: "POST", url: `/api/v1/sessions/${sessionId}/disconnect` },
      { method: "POST", url: `/api/v1/sessions/${sessionId}/logout` },
      { method: "DELETE", url: `/api/v1/sessions/${sessionId}` },
      { method: "GET", url: `/api/v1/sessions/${sessionId}/keys` },
      { method: "POST", url: `/api/v1/sessions/${sessionId}/keys`, payload: { name: "x" } },
      { method: "DELETE", url: `/api/v1/sessions/${sessionId}/keys/${keyId}` },
      {
        method: "PUT",
        url: `/api/v1/sessions/${sessionId}/webhook`,
        payload: { url: "https://example.com/hook" },
      },
      { method: "GET", url: `/api/v1/sessions/${sessionId}/webhook` },
      { method: "DELETE", url: `/api/v1/sessions/${sessionId}/webhook` },
      { method: "POST", url: `/api/v1/sessions/${sessionId}/webhook/test` },
      { method: "GET", url: `/api/v1/sessions/${sessionId}/webhook/deliveries` },
      {
        method: "POST",
        url: "/api/v1/send-message",
        payload: { sessionId, to: "+14155552671", text: "nope" },
        idempotency: true,
      },
    ];

    for (const c of cases) {
      const response = await app.inject({
        method: c.method,
        url: c.url,
        headers: {
          authorization: `Bearer ${accountB.accessToken}`,
          ...(c.idempotency ? { "idempotency-key": crypto.randomUUID() } : {}),
        },
        payload: c.payload,
      });
      expect(response.statusCode, `${c.method} ${c.url}`).toBe(404);
    }
  });

  it("fails if any account-scoped route is missing from the covered list", () => {
    const covered = new Set(
      ACCOUNT_SCOPED_ROUTE_PATTERNS.map((r) => `${r.method} ${normalizeUrl(r.url)}`),
    );
    const accountScoped = app.registeredRoutes.filter((r) => {
      if (!r.url.startsWith("/api/v1/")) return false;
      if (r.url.startsWith("/api/v1/auth")) return false;
      if (r.url === "/api/v1/sessions" && (r.method === "GET" || r.method === "POST")) return false;
      if (r.url === "/api/v1/messages" || r.url === "/api/v1/messages/") return false;
      if (r.url.includes(":id") || r.url.includes("send-message")) return true;
      return false;
    });
    for (const route of accountScoped) {
      const key = `${route.method} ${normalizeUrl(route.url)}`;
      expect(covered.has(key) || covered.has(`${route.method} ${route.url}`), `uncovered ${key}`).toBe(
        true,
      );
    }
  });

  it("enforces session-key scoping", async () => {
    const { accounts } = await import("@waapi/db");
    const auth = await registerVerifyLogin("sk-scope");
    await database.db
      .update(accounts)
      .set({ maxSessions: 2 })
      .where(eq(accounts.id, auth.accountId));
    const s1 = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: { name: "a" },
    });
    const s2 = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: { name: "b" },
    });
    const id1 = s1.json<{ id: string }>().id;
    const id2 = s2.json<{ id: string }>().id;
    const keyRes = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${id1}/keys`,
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: { name: "sk" },
    });
    const sk = keyRes.json<{ token: string }>().token;

    const forbiddenAccountWide = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${sk}` },
    });
    expect(forbiddenAccountWide.statusCode).toBe(403);

    const otherStatus = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${id2}/status`,
      headers: { authorization: `Bearer ${sk}` },
    });
    expect(otherStatus.statusCode).toBe(404);

    const ownStatus = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${id1}/status`,
      headers: { authorization: `Bearer ${sk}` },
    });
    expect(ownStatus.statusCode).toBe(200);

    const patForbidden = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      headers: { authorization: `Bearer ${sk}` },
      payload: { name: "nope" },
    });
    expect(patForbidden.statusCode).toBe(403);
  });

  it("PAT cannot manage tokens; JWT can", async () => {
    const auth = await registerVerifyLogin("pat-scope");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: { name: "pat1" },
    });
    expect(created.statusCode).toBe(201);
    const pat = created.json<{ token: string; id: string }>().token;

    const listWithPat = await app.inject({
      method: "GET",
      url: "/api/v1/auth/tokens",
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(listWithPat.statusCode).toBe(403);

    const sessionsOk = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(sessionsOk.statusCode).toBe(200);
  });

  it("allows exactly two of six concurrent session creates at a cap of two", async () => {
    const { accounts } = await import("@waapi/db");
    const auth = await registerVerifyLogin("cap");
    await database.db
      .update(accounts)
      .set({ maxSessions: 2 })
      .where(eq(accounts.id, auth.accountId));

    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        app.inject({
          method: "POST",
          url: "/api/v1/sessions",
          headers: { authorization: `Bearer ${auth.accessToken}` },
          payload: { name: `concurrent-${index}` },
        }),
      ),
    );
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(2);
    expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(4);
  });

  it("50 concurrent sends with one Idempotency-Key produce one outbound row", async () => {
    const { accounts, sessions, outboundMessages, idempotencyKeys } = await import("@waapi/db");
    const { randomUUID } = await import("node:crypto");
    const { sendText } = await import("./services/send.js");
    const accountId = randomUUID();
    accountIds.add(accountId);
    await database.db.insert(accounts).values({ id: accountId, name: "idempotency" });
    const [session] = await database.db
      .insert(sessions)
      .values({ accountId, name: "connected-stub", status: "connected" })
      .returning();
    const body = { sessionId: session!.id, to: "+14155552671", text: "hello" };
    const key = `idem-${randomUUID()}`;

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => sendText(database, accountId, body, key, randomUUID())),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
      id: string;
    }>[];
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(fulfilled.map((r) => r.value.id));
    expect(ids.size).toBe(1);

    const rows = await database.db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.accountId, accountId));
    expect(rows).toHaveLength(1);

    const keys = await database.db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.accountId, accountId));
    expect(keys).toHaveLength(1);
  });

  it("createSession deletes row when enqueue fails", async () => {
    const { sessions: sessionsTable } = await import("@waapi/db");
    const { createSession } = await import("./services/sessions.js");
    const { sessionCommandsQueue } = await import("./services/queues.js");
    const auth = await registerVerifyLogin("enqueue-fail");
    const original = sessionCommandsQueue.add.bind(sessionCommandsQueue);
    sessionCommandsQueue.add = (async () => {
      throw new Error("redis down");
    }) as typeof sessionCommandsQueue.add;
    try {
      await expect(
        createSession(database, auth.accountId, "orphan-check", "req"),
      ).rejects.toMatchObject({ statusCode: 503 });
      const rows = await database.db
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.accountId, auth.accountId));
      expect(rows.filter((r) => r.name === "orphan-check")).toHaveLength(0);
    } finally {
      sessionCommandsQueue.add = original;
    }
  });
});
