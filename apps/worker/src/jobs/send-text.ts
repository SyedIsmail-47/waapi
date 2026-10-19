import { Worker } from "bullmq";
import { QUEUE_SEND_TEXT, sendTextJobSchema } from "@waapi/shared";
import type { Redis } from "ioredis";
import type { Db } from "../db/client.js";
import { insertMessageLog } from "../db/message-logs.js";
import { getSessionForAccount } from "../db/sessions.js";
import type { Logger } from "../logger.js";
import type { SessionManager } from "../session/manager.js";

export function startSendTextWorker(args: {
  connection: Redis;
  db: Db["db"];
  manager: SessionManager;
  log: Logger;
}): Worker {
  const { connection, db, manager, log } = args;

  return new Worker(
    QUEUE_SEND_TEXT,
    async (job) => {
      const payload = sendTextJobSchema.parse(job.data);
      const session = await getSessionForAccount(db, payload.accountId, payload.sessionId);
      if (!session) {
        throw new Error("SESSION_NOT_FOUND_FOR_ACCOUNT");
      }
      if (session.status !== "connected") {
        throw new Error("SESSION_NOT_CONNECTED");
      }
      const client = manager.getClient(payload.sessionId);
      if (!client) {
        throw new Error("SESSION_NOT_ON_NODE");
      }
      const result = await client.sendText(payload.to, payload.text);
      await insertMessageLog(db, {
        accountId: payload.accountId,
        sessionId: payload.sessionId,
        direction: "outbound",
        remoteJid: result.remoteJid,
        messageId: result.messageId,
        fromMe: true,
        messageType: "conversation",
      });
      log.info(
        {
          sessionId: payload.sessionId,
          messageId: result.messageId,
          remoteJid: result.remoteJid,
          event: "message.sent",
        },
        "outbound message metadata",
      );
      return { messageId: result.messageId, remoteJid: result.remoteJid };
    },
    { connection, concurrency: 5 },
  );
}
