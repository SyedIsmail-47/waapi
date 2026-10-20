import { Worker } from "bullmq";
import { QUEUE_EMAIL } from "@waapi/shared";
import { config } from "../config.js";
import { redis } from "./queues.js";

export function startEmailWorker(): Worker {
  return new Worker(
    QUEUE_EMAIL,
    async (job) => {
      if (config.EMAIL_DRIVER === "console") {
        // Do not log raw tokens in production; redact.
        const data = { ...job.data } as Record<string, unknown>;
        if (typeof data.token === "string") data.token = "[redacted]";
        console.log(JSON.stringify({ service: "email", template: job.name, ...data }));
      }
    },
    {
      connection: redis,
      removeOnComplete: { age: 60, count: 100 },
      removeOnFail: { age: 300, count: 100 },
    },
  );
}
