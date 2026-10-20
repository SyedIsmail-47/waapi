import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import { config } from "../config.js";
import { clientIp } from "../lib/client-ip.js";
import { redis } from "../services/queues.js";

/**
 * Global limiter always keys by clientIp (before auth).
 * Garbage Authorization headers must NOT create token-hash buckets.
 * Per-account limiting is applied inside authenticate() after identity is known.
 */
export default fp(async (app) => {
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    redis,
    keyGenerator: (request) => `ip:${clientIp(request)}`,
    errorResponseBuilder: (_request, context) => ({
      error: {
        code: "RATE_LIMITED",
        message: `Rate limit exceeded, retry after ${context.after}`,
        requestId: _request.id,
      },
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
    });
  }
}
