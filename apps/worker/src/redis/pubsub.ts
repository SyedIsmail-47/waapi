import { Redis } from "ioredis";
import type { QrEvent, SessionStatusEvent } from "@waapi/shared";
import { QR_TTL_SECONDS, REDIS_CHANNEL, REDIS_KEY } from "@waapi/shared";

export function createRedis(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export async function publishQr(redis: Redis, event: QrEvent): Promise<void> {
  const at = event.at;
  const expiresAt =
    event.expiresAt ?? new Date(Date.parse(at) + QR_TTL_SECONDS * 1000).toISOString();
  const cache = {
    value: event.qr,
    updatedAt: at,
    expiresAt,
  };
  await redis.set(REDIS_KEY.qr(event.sessionId), JSON.stringify(cache), "EX", QR_TTL_SECONDS);
  await redis.publish(
    REDIS_CHANNEL.qr(event.sessionId),
    JSON.stringify({ ...event, expiresAt }),
  );
}

export async function publishStatus(redis: Redis, event: SessionStatusEvent): Promise<void> {
  await redis.publish(REDIS_CHANNEL.status(event.sessionId), JSON.stringify(event));
}
