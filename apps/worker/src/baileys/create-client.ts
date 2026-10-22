import type { WorkerConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import { createBaileysClient } from "./baileys-client.js";
import { createFakeClient } from "./fake-client.js";
import type { WAClient } from "./types.js";

export async function createWaClient(args: {
  sessionId: string;
  accountId: string;
  db: Db["db"];
  cfg: WorkerConfig;
  log: Logger;
}): Promise<WAClient> {
  if (args.cfg.waDriver === "fake") {
    args.log.info({ sessionId: args.sessionId }, "using fake WA driver");
    return createFakeClient({
      sessionId: args.sessionId,
      accountId: args.accountId,
      qrDelayMs: args.cfg.fakeQrDelayMs,
    });
  }
  return createBaileysClient(args);
}
