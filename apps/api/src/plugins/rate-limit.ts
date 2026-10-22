import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import { config } from "../config.js";
import { clientIp } from "../lib/client-ip.js";
import { redis } from "../services/queues.js";

const WINDOW_SEC = 60;

function windowBucket(windowSec = WINDOW_SEC): number {
  return Math.floor(Date.now() / (windowSec * 1000));
}

function rateLimited(message: string, afterSec = WINDOW_SEC): Error {
  return Object.assign(new Error(message), {
    statusCode: 429,
    code: "RATE_LIMITED",
    after: afterSec,
  });
}

/**
 * Global limiter always keys by clientIp (before auth).
 * Garbage Authorization headers must NOT create token-hash buckets.
 * Per-account limiting is applied inside authenticate() after identity is known.
 * Failed-auth limiting is applied around authenticate() failures.
 *
 * @fastify/rate-limit throws the value returned by errorResponseBuilder.
 * That value MUST be Error-like with numeric statusCode — a plain body object
 * has no statusCode, and the global handler then falls through to 500.
 */
export default fp(async (app) => {
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_IP_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    redis,
    keyGenerator: (request) => `ip:${clientIp(request)}`,
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error(`Rate limit exceeded, retry after ${context.after}`), {
        statusCode: context.statusCode,
        code: "RATE_LIMITED",
        after: context.after,
      }),
  });
});

/** Block when this IP already exhausted the failed-auth budget. */
export async function assertFailedAuthAllowed(ip: string): Promise<void> {
  const redisKey = `rl:failauth:ip:${ip}:${windowBucket()}`;
  const count = Number((await redis.get(redisKey)) ?? 0);
  if (count >= config.RATE_LIMIT_FAILED_AUTH_MAX) {
    throw rateLimited("Too many failed authentication attempts");
  }
}

/** Record a failed auth attempt; throw 429 once the budget is exceeded. */
export async function recordFailedAuth(ip: string): Promise<void> {
  const redisKey = `rl:failauth:ip:${ip}:${windowBucket()}`;
  const count = await redis.incr(redisKey);
  if (count === 1) await redis.expire(redisKey, WINDOW_SEC);
  if (count > config.RATE_LIMIT_FAILED_AUTH_MAX) {
    throw rateLimited("Too many failed authentication attempts");
  }
}

export async function enforceAccountRateLimit(accountId: string): Promise<void> {
  const redisKey = `rl:acct:${accountId}:${windowBucket()}`;
  const count = await redis.incr(redisKey);
  if (count === 1) await redis.expire(redisKey, WINDOW_SEC);
  if (count > config.RATE_LIMIT_ACCOUNT_MAX) {
    throw rateLimited("Account rate limit exceeded");
  }
}

/** Stricter per-account ceiling for POST /send-message. */
export async function enforceSendRateLimit(accountId: string): Promise<void> {
  const redisKey = `rl:send:${accountId}:${windowBucket()}`;
  const count = await redis.incr(redisKey);
  if (count === 1) await redis.expire(redisKey, WINDOW_SEC);
  if (count > config.SEND_RATE_LIMIT_MAX) {
    throw rateLimited("Send rate limit exceeded");
  }
}
