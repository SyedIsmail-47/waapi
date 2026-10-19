import type { Redis } from "ioredis";
import { z } from "zod";
import type { Logger } from "../logger.js";
import type { SessionManager } from "../session/manager.js";

export const WORKER_COMMAND_CHANNEL = "waapi:worker:commands";

const openCommandSchema = z.object({
  type: z.literal("open_session"),
  accountId: z.string().uuid(),
  sessionId: z.string().uuid(),
});

export async function publishOpenSession(
  redis: Redis,
  accountId: string,
  sessionId: string,
): Promise<void> {
  await redis.publish(
    WORKER_COMMAND_CHANNEL,
    JSON.stringify({ type: "open_session", accountId, sessionId }),
  );
}

export function subscribeWorkerCommands(args: {
  redis: Redis;
  manager: SessionManager;
  log: Logger;
}): void {
  const sub = args.redis.duplicate();
  void sub.subscribe(WORKER_COMMAND_CHANNEL);
  sub.on("message", (_ch: string, raw: string) => {
    void (async () => {
      try {
        const parsed = openCommandSchema.parse(JSON.parse(raw));
        await args.manager.openSession(parsed.accountId, parsed.sessionId);
      } catch (err) {
        args.log.error({ err }, "worker command failed");
      }
    })();
  });
}
