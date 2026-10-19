import { Redis } from "ioredis";
import type { QrEvent, SessionStatusEvent } from "@waapi/shared";
import { REDIS_CHANNEL } from "@waapi/shared";

export function createRedis(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export async function publishQr(redis: Redis, event: QrEvent): Promise<void> {
  await redis.publish(REDIS_CHANNEL.qr(event.sessionId), JSON.stringify(event));
}

export async function publishStatus(redis: Redis, event: SessionStatusEvent): Promise<void> {
  await redis.publish(REDIS_CHANNEL.status(event.sessionId), JSON.stringify(event));
}
