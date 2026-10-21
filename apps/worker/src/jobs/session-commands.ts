import { Worker } from "bullmq";
import { QUEUE_SESSION_COMMANDS, workerCommandSchema } from "@waapi/shared";
import type { Redis } from "ioredis";
import type { Logger } from "../logger.js";
import type { SessionManager } from "../session/manager.js";

async function withNotFoundRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const message = err instanceof Error ? err.message : String(err);
      if (message !== "SESSION_NOT_FOUND_FOR_ACCOUNT" || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
  throw last;
}

export function startSessionCommandsWorker(args: {
  connection: Redis;
  manager: SessionManager;
  log: Logger;
}): Worker {
  const { connection, manager, log } = args;

  return new Worker(
    QUEUE_SESSION_COMMANDS,
    async (job) => {
      const cmd = workerCommandSchema.parse(job.data);
      log.info({ type: cmd.type, sessionId: cmd.sessionId }, "session command");
      switch (cmd.type) {
        case "open-session":
          await withNotFoundRetry(() => manager.openSession(cmd.accountId, cmd.sessionId));
          break;
        case "close-session":
          await withNotFoundRetry(() => manager.closeSession(cmd.accountId, cmd.sessionId));
          break;
        case "logout-session":
          await withNotFoundRetry(() => manager.logoutSession(cmd.accountId, cmd.sessionId));
          break;
        case "send-message":
          throw new Error("SEND_MESSAGE_WRONG_QUEUE");
        default:
          break;
      }
    },
    {
      connection,
      concurrency: 5,
      removeOnComplete: { age: 60, count: 200 },
      removeOnFail: { age: 300, count: 200 },
    },
  );
}
