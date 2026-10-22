import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
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

describe("Phase 2 round 3", () => {
  let app: BuiltApp;
  let database: Db;
  const accountIds = new Set<string>();

  beforeAll(async () => {
    await import("dotenv/config");
    process.env.NODE_ENV = "test";
    process.env.DEV_RETURN_TOKENS = "true";
    process.env.ALLOW_HTTP_WEBHOOKS = "true";
    process.env.RATE_LIMIT_IP_MAX = "10000";
    process.env.RATE_LIMIT_FAILED_AUTH_MAX = "10000";
    process.env.RATE_LIMIT_ACCOUNT_MAX = "10000";
    if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
      throw new Error("DATABASE_URL and REDIS_URL required");
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
    const email = `${label}-${randomUUID()}@example.test`;
    const password = "correct-horse-battery-staple";
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password, name: label, acceptTerms: true },
    });
    expect(registered.statusCode).toBe(201);
    const body = registered.json<{
      accountId: string;
      userId: string;
      verificationToken?: string;
    }>();
    accountIds.add(body.accountId);
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
    return {
      accountId: body.accountId,
      userId: body.userId,
      email,
      password,
      ...tokens,
    };
  }

  it("refresh reuse within grace returns successor; after grace family revoked + audit", async () => {
    const { refreshTokens, securityAuditLog } = await import("@waapi/db");
    const { redis } = await import("./services/queues.js");
    const auth = await registerVerifyLogin("reuse-db");
    const rotated = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: auth.refreshToken },
    });
    expect(rotated.statusCode).toBe(200);
    const next = rotated.json<{ refreshToken: string }>().refreshToken;

    const graceReuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: auth.refreshToken },
    });
    expect(graceReuse.statusCode).toBe(200);
    expect(graceReuse.json<{ refreshToken: string }>().refreshToken).toBe(next);

    const oldHash = createHash("sha256").update(auth.refreshToken).digest("hex");
    await redis.del(`refresh:grace:${oldHash}`);

    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: auth.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);

    const hash = createHash("sha256").update(next).digest("hex");
    const [probe] = await database.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hash))
      .limit(1);
    expect(probe).toBeTruthy();
    const familyId = probe!.familyId;

    const familyRows = await database.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.familyId, familyId));
    expect(familyRows.length).toBeGreaterThanOrEqual(2);
    for (const row of familyRows) {
      expect(row.revokedAt, `token ${row.id} missing revoked_at`).not.toBeNull();
    }

    const audits = await database.db
      .select()
      .from(securityAuditLog)
      .where(
        and(
          eq(securityAuditLog.userId, auth.userId),
          eq(securityAuditLog.eventType, "auth.refresh_reuse"),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("50 concurrent sends × 20 loops → 1 outbound row and 1 job each key", async () => {
    const { accounts, sessions, outboundMessages } = await import("@waapi/db");
    const { sendText } = await import("./services/send.js");
    const { sendTextQueue } = await import("./services/queues.js");

    for (let loop = 0; loop < 20; loop++) {
      const accountId = randomUUID();
      accountIds.add(accountId);
      await database.db.insert(accounts).values({ id: accountId, name: `idem-${loop}` });
      const [session] = await database.db
        .insert(sessions)
        .values({ accountId, name: "c", status: "connected" })
        .returning();
      const body = { sessionId: session!.id, to: "+14155552671", text: "hello" };
      const key = `k-${loop}-${randomUUID()}`;

      const results = await Promise.allSettled(
        Array.from({ length: 50 }, () =>
          sendText(database, accountId, body, key, randomUUID()),
        ),
      );
      const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
        id: string;
      }>[];
      expect(fulfilled.length, `loop ${loop} fulfilled`).toBeGreaterThanOrEqual(1);
      expect(new Set(fulfilled.map((r) => r.value.id)).size, `loop ${loop} ids`).toBe(1);

      const rows = await database.db
        .select()
        .from(outboundMessages)
        .where(eq(outboundMessages.accountId, accountId));
      expect(rows, `loop ${loop} outbound`).toHaveLength(1);

      const job = await sendTextQueue.getJob(rows[0]!.id);
      expect(job, `loop ${loop} job`).toBeTruthy();
      // Exactly one BullMQ job id for this outbound row (jobId === message id).
      expect(job!.id, `loop ${loop} job id`).toBe(rows[0]!.id);
    }
  }, 120_000);

  it("failed enqueue then retry with same key succeeds", async () => {
    const { accounts, sessions, outboundMessages, idempotencyKeys } = await import("@waapi/db");
    const { sendText } = await import("./services/send.js");
    const { sendTextQueue } = await import("./services/queues.js");
    const accountId = randomUUID();
    accountIds.add(accountId);
    await database.db.insert(accounts).values({ id: accountId, name: "enqueue-retry" });
    const [session] = await database.db
      .insert(sessions)
      .values({ accountId, name: "c", status: "connected" })
      .returning();
    const body = { sessionId: session!.id, to: "+14155552671", text: "retry-me" };
    const key = `retry-${randomUUID()}`;

    const original = sendTextQueue.add.bind(sendTextQueue);
    let calls = 0;
    sendTextQueue.add = (async (...args: Parameters<typeof sendTextQueue.add>) => {
      calls += 1;
      if (calls === 1) throw new Error("redis blip");
      return original(...args);
    }) as typeof sendTextQueue.add;

    try {
      await expect(sendText(database, accountId, body, key, "r1")).rejects.toMatchObject({
        statusCode: 503,
      });
      const keysAfterFail = await database.db
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.accountId, accountId));
      expect(keysAfterFail).toHaveLength(0);

      const ok = await sendText(database, accountId, body, key, "r2");
      expect(ok.status).toBe("queued");
      expect(ok.id).toBeTruthy();
      const rows = await database.db
        .select()
        .from(outboundMessages)
        .where(eq(outboundMessages.accountId, accountId));
      expect(rows).toHaveLength(1);
    } finally {
      sendTextQueue.add = original;
    }
  });

  it("200 random Authorization headers do not create per-token rate-limit buckets", async () => {
    const { redis } = await import("./services/queues.js");
    const before = await redis.keys("rl:*");
    const beforeTokenish = before.filter((k) => /token|pat|bearer|hash/i.test(k));

    for (let i = 0; i < 200; i++) {
      await app.inject({
        method: "GET",
        url: "/api/v1/sessions",
        headers: { authorization: `Bearer garbage_${randomUUID()}_${i}` },
      });
    }

    const after = await redis.keys("rl:*");
    const afterTokenish = after.filter((k) => /token|pat|bearer|hash/i.test(k));
    expect(afterTokenish.length).toBe(beforeTokenish.length);
    // Only IP-keyed global buckets (+ account keys from real auth elsewhere)
    const ipKeys = after.filter((k) => k.includes("ip:") || k.startsWith("waapi-api") || k.includes(":ip"));
    expect(ipKeys.length + after.filter((k) => k.startsWith("rl:acct:")).length).toBeLessThanOrEqual(
      after.length,
    );
  });

  it("GET /messages?sessionId=<other account> returns empty for account B", async () => {
    const { messageLogs } = await import("@waapi/db");
    const [a, b] = await Promise.all([
      registerVerifyLogin("msg-a"),
      registerVerifyLogin("msg-b"),
    ]);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { name: "msg-s" },
    });
    const sessionId = created.json<{ id: string }>().id;
    await database.db.insert(messageLogs).values({
      accountId: a.accountId,
      sessionId,
      direction: "inbound",
      remoteJid: "14155552671@s.whatsapp.net",
      messageId: randomUUID(),
      fromMe: false,
      messageType: "conversation",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/messages?sessionId=${sessionId}`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it("DELETE /sessions/:id returns 202; connect on logged_out returns 409", async () => {
    const { sessions } = await import("@waapi/db");
    const auth = await registerVerifyLogin("del-202");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: { name: "to-delete" },
    });
    const id = created.json<{ id: string }>().id;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/sessions/${id}`,
      headers: { authorization: `Bearer ${auth.accessToken}` },
    });
    expect(del.statusCode).toBe(202);
    expect(del.json()).toMatchObject({ id, accepted: true });

    // Simulate worker logged_out without hard-delete for connect check
    const auth2 = await registerVerifyLogin("logged-out-connect");
    const s2 = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${auth2.accessToken}` },
      payload: { name: "lo" },
    });
    const id2 = s2.json<{ id: string }>().id;
    await database.db
      .update(sessions)
      .set({ status: "logged_out" })
      .where(eq(sessions.id, id2));
    const connect = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${id2}/connect`,
      headers: { authorization: `Bearer ${auth2.accessToken}` },
    });
    expect(connect.statusCode).toBe(409);
    expect(connect.json().error.code).toBe("SESSION_LOGGED_OUT");
  });

  it("route matrix: every registered route × auth modes", async () => {
    const auth = await registerVerifyLogin("matrix");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: { name: "matrix-s" },
    });
    const sessionId = created.json<{ id: string }>().id;
    const keyRes = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/keys`,
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: { name: "sk" },
    });
    const sk = keyRes.json<{ token: string }>().token;
    const patRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: { name: "pat" },
    });
    const pat = patRes.json<{ token: string }>().token;

    const fill = (url: string) =>
      url
        .replace(":id", sessionId)
        // Use a non-existent key id so DELETE does not revoke the live session_key under test.
        .replace(":keyId", randomUUID())
        .replace(":deliveryId", randomUUID());

    const expectStatus = (
      method: string,
      url: string,
      mode: "none" | "jwt" | "pat" | "session_key",
    ): number | number[] => {
      if (
        url === "/health" ||
        url === "/ready" ||
        url.startsWith("/health") ||
        url.startsWith("/docs") ||
        url === "/openapi.json"
      ) {
        return [200, 302, 404];
      }
      if (url.includes("/signup-config")) {
        return 200;
      }
      if (url.includes("/billing/webhooks")) {
        return [400, 401, 404];
      }
      if (url.startsWith("/api/v1/billing")) {
        if (mode === "none") return 401;
        if (mode === "jwt") return [200, 400, 404];
        return 403;
      }
      if (url.startsWith("/api/v1/auth/register") || url.includes("/login") ||
          url.includes("/refresh") || url.includes("/verify-email") ||
          url.includes("/resend-verification") || url.includes("/forgot-password") ||
          url.includes("/reset-password") ||
          (url === "/api/v1/auth/logout" && method === "POST")) {
        // Public auth routes — invalid body/token → 400/401 (never 5xx)
        // POST /auth/logout clears cookies even without a session (204).
        return [400, 401, 202, 204, 201, 200, 403, 429];
      }
      if (mode === "none") return 401;
      if (url === "/api/v1/auth/me") {
        if (mode === "jwt") return 200;
        return 403;
      }
      if (
        url.startsWith("/api/v1/auth/tokens") ||
        url.includes("/logout-all") ||
        url.includes("/change-password") ||
        url.includes("/delete-account")
      ) {
        if (mode === "jwt") return [200, 201, 204, 400, 401, 404];
        return 403;
      }
      if (url === "/api/v1/sessions" && method === "GET") {
        if (mode === "session_key") return 403;
        return 200;
      }
      if (url === "/api/v1/sessions" && method === "POST") {
        if (mode === "session_key") return 403;
        return [201, 409, 503];
      }
      if (url.includes("/messages")) {
        return 200;
      }
      if (url.includes("/send-message")) {
        return [202, 400, 409, 404];
      }
      if (url.includes("/webhook")) {
        if (mode === "session_key") return 403;
        return [200, 201, 202, 204, 404, 400];
      }
      if (url.includes("/keys")) {
        // session_key is forbidden (403); 401 if the key was already revoked earlier in the matrix
        if (mode === "session_key") return [401, 403];
        return [200, 201, 204, 404];
      }
      if (url.includes("/sessions/") && url.includes("/logout")) {
        if (mode === "session_key") return 403;
        return [202, 404, 409];
      }
      if (url.includes("/status")) {
        return [200, 404];
      }
      if (method === "DELETE" && url.includes("/sessions/")) {
        if (mode === "session_key") return 403;
        return [202, 404];
      }
      if (url.includes("/connect") || url.includes("/disconnect") || url.includes("/logout")) {
        if (mode === "session_key") return 403;
        return [202, 404, 409];
      }
      if (method === "PATCH" && url.includes("/sessions/")) {
        if (mode === "session_key") return 403;
        return [200, 400, 404];
      }
      if (method === "GET" && url.includes("/sessions/")) {
        if (mode === "session_key") return 403;
        return [200, 404];
      }
      return [200, 201, 202, 204, 400, 401, 403, 404, 409];
    };

    const routes = app.registeredRoutes.filter(
      (r) =>
        !r.url.includes("*") &&
        !r.url.startsWith("/docs") &&
        r.url !== "/openapi.json",
    );

    for (const route of routes) {
      const url = fill(route.url);
      // Non-destructive auth modes first; jwt last so DELETE side-effects don't break later modes.
      for (const mode of ["none", "session_key", "pat", "jwt"] as const) {
        const headers: Record<string, string> = {};
        if (mode === "jwt") headers.authorization = `Bearer ${auth.accessToken}`;
        if (mode === "pat") headers.authorization = `Bearer ${pat}`;
        if (mode === "session_key") headers.authorization = `Bearer ${sk}`;
        if (url.includes("send-message")) headers["idempotency-key"] = randomUUID();

        const payload =
          route.method === "GET" || route.method === "DELETE"
            ? undefined
            : url.includes("send-message")
              ? { sessionId, to: "+14155552671", text: "x" }
              : url.includes("webhook") && route.method === "PUT"
                ? { url: "https://example.com/hook" }
                : url.includes("/keys")
                  ? { name: "n" }
                  : url.includes("register")
                    ? { email: `m-${randomUUID()}@t.test`, password: "correct-horse-battery-staple" }
                    : url.includes("login")
                      ? { email: auth.email, password: auth.password }
                      : url.includes("refresh")
                        ? { refreshToken: auth.refreshToken }
                        : { token: "x", email: auth.email, password: "x", name: "x" };

        const res = await app.inject({
          method: route.method as "GET",
          url,
          headers,
          payload,
        });
        expect(
          res.statusCode,
          `${route.method} ${route.url} mode=${mode} unexpected 5xx`,
        ).toBeLessThan(500);
        const expected = expectStatus(route.method, route.url, mode);
        const ok = Array.isArray(expected)
          ? expected.includes(res.statusCode)
          : res.statusCode === expected;
        expect(ok, `${route.method} ${route.url} mode=${mode} got ${res.statusCode}`).toBe(true);
      }
    }
  }, 120_000);

  it("new account max_sessions defaults to 1", async () => {
    const { accounts } = await import("@waapi/db");
    const auth = await registerVerifyLogin("max1");
    const [row] = await database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, auth.accountId))
      .limit(1);
    expect(row!.maxSessions).toBe(1);
  });
});
