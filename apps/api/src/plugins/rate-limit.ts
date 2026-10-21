import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import { config } from "../config.js";
import { clientIp } from "../lib/client-ip.js";
import { redis } from "../services/queues.js";

/**
 * Global limiter always keys by clientIp (before auth).
 * Garbage Authorization headers must NOT create token-hash buckets.
 * Per-account limiting is applied inside authenticate() after identity is known.
 *
 * @fastify/rate-limit throws the value returned by errorResponseBuilder.
 * That value MUST be Error-like with numeric statusCode — a plain body object
 * has no statusCode, and the global handler then falls through to 500.
 */
export default fp(async (app) => {
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    redis,
    keyGenerator: (request) => `ip:${clientIp(request)}`,
    errorResponseBuilder: (request, context) =>
      Object.assign(new Error(`Rate limit exceeded, retry after ${context.after}`), {
        statusCode: context.statusCode,
        code: "RATE_LIMITED",
        after: context.after,
      }),
  });
});

export async function enforceAccountRateLimit(accountId: string): Promise<void> {
  const windowSec = 60;
  const redisKey = `rl:acct:${accountId}:${Math.floor(Date.now() / (windowSec * 1000))}`;
  const count = await redis.incr(redisKey);
  if (count === 1) await redis.expire(redisKey, windowSec);
  if (count > config.RATE_LIMIT_ACCOUNT_MAX) {
    throw Object.assign(new Error("Account rate limit exceeded"), {
      statusCode: 429,
      code: "RATE_LIMITED",
      after: windowSec,
    });
  }
}
