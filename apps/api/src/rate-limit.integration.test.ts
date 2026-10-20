import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { BuiltApp } from "./app.js";

type AuthSession = {
  accountId: string;
  accessToken: string;
  email: string;
  password: string;
};

function assertRateLimited(res: { statusCode: number; headers: Record<string, unknown>; json: () => unknown }) {
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

describe("rate-limit responses", () => {
  let app: BuiltApp;
  let redis: { keys: (p: string) => Promise<string[]>; del: (...k: string[]) => Promise<number> };
  const accountIds = new Set<string>();
  const loginIp = "203.0.113.10";
  const globalIp = "203.0.113.20";
  const accountIp = "203.0.113.30";

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.DEV_RETURN_TOKENS = "true";
    process.env.ALLOW_HTTP_WEBHOOKS = "true";
    process.env.RATE_LIMIT_MAX = "5";
    process.env.RATE_LIMIT_LOGIN = "3";
    process.env.RATE_LIMIT_REGISTER = "10000";
    process.env.RATE_LIMIT_REFRESH = "10000";
    process.env.RATE_LIMIT_FORGOT_PASSWORD = "10000";
    process.env.RATE_LIMIT_RESET_PASSWORD = "10000";
    process.env.RATE_LIMIT_VERIFY_EMAIL = "10000";
    process.env.RATE_LIMIT_RESEND_VERIFICATION = "10000";
    process.env.RATE_LIMIT_ACCOUNT_MAX = "4";
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
    // Restore high caps so sibling test files in the same worker do not inherit probe limits.
    process.env.RATE_LIMIT_MAX = "10000";
    process.env.RATE_LIMIT_LOGIN = "10000";
    process.env.RATE_LIMIT_REGISTER = "10000";
    process.env.RATE_LIMIT_REFRESH = "10000";
    process.env.RATE_LIMIT_FORGOT_PASSWORD = "10000";
    process.env.RATE_LIMIT_RESET_PASSWORD = "10000";
    process.env.RATE_LIMIT_VERIFY_EMAIL = "10000";
    process.env.RATE_LIMIT_RESEND_VERIFICATION = "10000";
    process.env.RATE_LIMIT_ACCOUNT_MAX = "10000";
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
      payload: { email, password, name: label },
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

  it("login limit: inject over RATE_LIMIT_LOGIN returns 429 + Retry-After + body", async () => {
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

  it("global limit: garbage bearer tokens yield 429, never 500", async () => {
    const statuses: number[] = [];
    let limited: Awaited<ReturnType<BuiltApp["inject"]>> | undefined;
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/sessions",
        remoteAddress: globalIp,
        headers: { authorization: `Bearer garbage-${randomUUID()}` },
      });
      statuses.push(res.statusCode);
      expect(res.statusCode).toBeLessThan(500);
      if (res.statusCode === 429) {
        limited = res;
        break;
      }
    }
    expect(statuses.some((s) => s === 401)).toBe(true);
    expect(limited).toBeTruthy();
    assertRateLimited(limited!);
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
  });

  it("per-account limit: shared bucket across two PATs of the same account", async () => {
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

    const bucketKeys = await redis.keys(`rl:acct:${auth.accountId}:*`);
    if (bucketKeys.length) await redis.del(...bucketKeys);

    const accountMax = Number(process.env.RATE_LIMIT_ACCOUNT_MAX);
    const statusesA: number[] = [];
    let limitedA: Awaited<ReturnType<BuiltApp["inject"]>> | undefined;
    for (let i = 0; i < accountMax + 3; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/sessions",
        // Distinct IPs so the global IP bucket does not fire first.
        remoteAddress: `198.51.100.${10 + i}`,
        headers: { authorization: `Bearer ${patTokens[0]}` },
      });
      statusesA.push(res.statusCode);
      expect(res.statusCode).toBeLessThan(500);
      if (res.statusCode === 429) {
        limitedA = res;
        break;
      }
    }
    expect(statusesA.filter((s) => s === 200).length).toBe(accountMax);
    expect(limitedA).toBeTruthy();
    assertRateLimited(limitedA!);

    const withOtherPat = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      remoteAddress: "198.51.100.200",
      headers: { authorization: `Bearer ${patTokens[1]}` },
    });
    expect(withOtherPat.statusCode).toBeLessThan(500);
    assertRateLimited(withOtherPat);
  });
});
