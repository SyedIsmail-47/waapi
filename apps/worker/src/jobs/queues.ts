import { Queue } from "bullmq";
import { QUEUE_SEND_TEXT } from "@waapi/shared";
import type { SendTextJob } from "@waapi/shared";
import type { Redis } from "ioredis";

export function createSendTextQueue(connection: Redis): Queue<SendTextJob> {
  return new Queue<SendTextJob>(QUEUE_SEND_TEXT, { connection });
}
