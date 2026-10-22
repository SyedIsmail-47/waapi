import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { BuiltApp } from "./app.js";

type AuthSession = {
  accountId: string;
  accessToken: string;
  email: string;
  password: string;
};

function assertRateLimited(res: {
  statusCode: number;
  headers: Record<string, unknown>;
  json: () => unknown;
}) {
  expect(res.statusCode).toBe(429);
  const retryAfter = res.headers["retry-after"] ?? res.headers["Retry-After"];
  expect(retryAfter, "Retry-After header required").toBeTruthy();
  const body = res.json() as {
    error?: { code?: string; message?: string; requestId?: string };
  };
  expect(body.error?.code).toBe("RATE_LIMITED");
  expect(typeof body.error?.message).toBe("string");
  expect(body.error?.message!.length).toBeGreaterThan(0);
  expect(typeof body.error?.requestId).toBe("string");
  expect(body.error?.requestId!.length).toBeGreaterThan(0);
}

describe("rate-limit tiers", () => {
  let app: BuiltApp;
  let redis: {
    keys: (p: string) => Promise<string[]>;
    del: (...k: string[]) => Promise<number>;
    set: (key: string, value: string, ...args: Array<string | number>) => Promise<unknown>;
  };
  const accountIds = new Set<string>();
  const patIp = "203.0.113.40";
  const garbageIp = "203.0.113.41";
  const loginIp = "203.0.113.42";
  const accountIp = "203.0.113.43";

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.DEV_RETURN_TOKENS = "true";
    process.env.ALLOW_HTTP_WEBHOOKS = "true";
    process.env.RATE_LIMIT_IP_MAX = "600";
    process.env.RATE_LIMIT_FAILED_AUTH_MAX = "30";
    process.env.RATE_LIMIT_LOGIN = "3";
    process.env.RATE_LIMIT_REGISTER = "10000";
    process.env.RATE_LIMIT_REFRESH = "10000";
    process.env.RATE_LIMIT_FORGOT_PASSWORD = "10000";
    process.env.RATE_LIMIT_RESET_PASSWORD = "10000";
    process.env.RATE_LIMIT_VERIFY_EMAIL = "10000";
    process.env.RATE_LIMIT_RESEND_VERIFICATION = "10000";
    process.env.RATE_LIMIT_ACCOUNT_MAX = "300";
    process.env.SEND_RATE_LIMIT_MAX = "120";
    process.env.RATE_LIMIT_WINDOW = "1 minute";
    if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
      throw new Error("DATABASE_URL and REDIS_URL required");
    }
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    const queues = await import("./services/queues.js");
    redis = queues.redis;
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    process.env.RATE_LIMIT_IP_MAX = "10000";
    process.env.RATE_LIMIT_FAILED_AUTH_MAX = "10000";
    process.env.RATE_LIMIT_LOGIN = "10000";
    process.env.RATE_LIMIT_REGISTER = "10000";
    process.env.RATE_LIMIT_REFRESH = "10000";
    process.env.RATE_LIMIT_FORGOT_PASSWORD = "10000";
    process.env.RATE_LIMIT_RESET_PASSWORD = "10000";
    process.env.RATE_LIMIT_VERIFY_EMAIL = "10000";
    process.env.RATE_LIMIT_RESEND_VERIFICATION = "10000";
    process.env.RATE_LIMIT_ACCOUNT_MAX = "10000";
    process.env.SEND_RATE_LIMIT_MAX = "10000";
    if (!app) return;
    try {
      const { accounts } = await import("@waapi/db");
      const { inArray } = await import("drizzle-orm");
      if (accountIds.size) {
        await app.database.db.delete(accounts).where(inArray(accounts.id, [...accountIds]));
      }
    } finally {
      await app.close();
    }
  });

  async function registerVerifyLogin(label: string, remoteAddress: string): Promise<AuthSession> {
    const email = `${label}-${randomUUID()}@example.test`;
    const password = "correct-horse-battery-staple";
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      remoteAddress,
      payload: {email, password, name: label, acceptTerms: true},
    });
    expect(registered.statusCode).toBe(201);
    const body = registered.json<{
      accountId: string;
      verificationToken?: string;
    }>();
    accountIds.add(body.accountId);
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      remoteAddress,
      payload: { token: body.verificationToken },
    });
    const loggedIn = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress,
      payload: { email, password },
    });
    expect(loggedIn.statusCode).toBe(200);
    return {
      accountId: body.accountId,
      email,
      password,
      accessToken: loggedIn.json<{ accessToken: string }>().accessToken,
    };
  }

  it("valid PAT: 200 requests/min from one IP all succeed (200)", async () => {
    const auth = await registerVerifyLogin("rl-pat-ok", patIp);
    const patRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      remoteAddress: patIp,
      headers: { authorization: `Bearer ${auth.accessToken}` },
      payload: { name: "probe-pat" },
    });
    expect(patRes.statusCode).toBe(201);
    const pat = patRes.json<{ token: string }>().token;

    const bucketKeys = await redis.keys(`rl:acct:${auth.accountId}:*`);
    if (bucketKeys.length) await redis.del(...bucketKeys);

    const statuses: number[] = [];
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/sessions",
        remoteAddress: patIp,
        headers: { authorization: `Bearer ${pat}` },
      });
      statuses.push(res.statusCode);
      expect(res.statusCode).toBeLessThan(500);
    }
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(statuses).toHaveLength(200);
  }, 60_000);

  it("garbage tokens: 401 then 429 after RATE_LIMIT_FAILED_AUTH_MAX", async () => {
    const failedMax = Number(process.env.RATE_LIMIT_FAILED_AUTH_MAX);
    const statuses: number[] = [];
    let limited: Awaited<ReturnType<BuiltApp["inject"]>> | undefined;
    for (let i = 0; i < failedMax + 5; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/sessions",
        remoteAddress: garbageIp,
        headers: { authorization: `Bearer garbage-${randomUUID()}` },
      });
      statuses.push(res.statusCode);
      expect(res.statusCode).toBeLessThan(500);
      if (res.statusCode === 429) {
        limited = res;
        break;
      }
    }
    expect(statuses.filter((s) => s === 401).length).toBe(failedMax);
    expect(limited).toBeTruthy();
    assertRateLimited(limited!);
  });

  it("login route limit still returns 429 + Retry-After + body", async () => {
    const statuses: number[] = [];
    let limited: Awaited<ReturnType<BuiltApp["inject"]>> | undefined;
    for (let i = 0; i < 8; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress: loginIp,
        payload: { email: `nobody-${i}@example.test`, password: "wrong-password-value" },
      });
      statuses.push(res.statusCode);
      if (res.statusCode === 429) {
        limited = res;
        break;
      }
    }
    expect(statuses.filter((s) => s === 401).length).toBeGreaterThanOrEqual(3);
    expect(limited).toBeTruthy();
    assertRateLimited(limited!);
  });

  it("per-account limit: two PATs of the same account share one bucket", async () => {
    const auth = await registerVerifyLogin("rl-acct", accountIp);
    const patTokens: string[] = [];
    for (const name of ["pat-a", "pat-b"]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/auth/tokens",
        remoteAddress: accountIp,
        headers: { authorization: `Bearer ${auth.accessToken}` },
        payload: { name },
      });
      expect(created.statusCode).toBe(201);
      patTokens.push(created.json<{ token: string }>().token);
    }

    const windowSec = 60;
    const redisKey = `rl:acct:${auth.accountId}:${Math.floor(Date.now() / (windowSec * 1000))}`;
    // Config ACCOUNT_MAX=300: leave one slot, then second PAT must 429.
    await redis.set(redisKey, "299", "EX", windowSec);

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      remoteAddress: "198.51.100.11",
      headers: { authorization: `Bearer ${patTokens[0]}` },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      remoteAddress: "198.51.100.12",
      headers: { authorization: `Bearer ${patTokens[1]}` },
    });
    expect(second.statusCode).toBeLessThan(500);
    assertRateLimited(second);
  });
});
