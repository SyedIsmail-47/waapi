import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import {
  QUEUE_EMAIL,
  QUEUE_SEND_TEXT,
  QUEUE_SESSION_COMMANDS,
  QUEUE_WEBHOOK_DELIVERY,
} from "@waapi/shared";
import { config } from "../config.js";

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const connection = redis;

/** Short retention. Send-text redacts body before final fail; keep fails brief. */
export const defaultJobOptions: JobsOptions = {
  removeOnComplete: { age: 60, count: 200 },
  removeOnFail: { age: 1, count: 50 },
};

export const sessionCommandsQueue = new Queue(QUEUE_SESSION_COMMANDS, {
  connection,
  defaultJobOptions,
});
export const sendTextQueue = new Queue(QUEUE_SEND_TEXT, {
  connection,
  defaultJobOptions,
});
export const webhookDeliveryQueue = new Queue(QUEUE_WEBHOOK_DELIVERY, {
  connection,
  defaultJobOptions,
});
export const emailQueue = new Queue(QUEUE_EMAIL, {
  connection,
  defaultJobOptions,
});

export async function closeQueues(): Promise<void> {
  await Promise.all([
    sessionCommandsQueue.close(),
    sendTextQueue.close(),
    webhookDeliveryQueue.close(),
    emailQueue.close(),
  ]);
  await redis.quit();
}
