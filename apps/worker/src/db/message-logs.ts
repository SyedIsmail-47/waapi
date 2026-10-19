import type { Db } from "./client.js";
import { messageLogs } from "./schema.js";
import { and, eq } from "drizzle-orm";

export type MessageLogInsert = {
  accountId: string;
  sessionId: string;
  direction: "inbound" | "outbound";
  remoteJid: string;
  messageId: string;
  fromMe: boolean;
  messageType: string;
};

export async function insertMessageLog(db: Db["db"], row: MessageLogInsert) {
  const [created] = await db.insert(messageLogs).values(row).returning();
  return created!;
}

export async function listMessageLogsForAccount(
  db: Db["db"],
  accountId: string,
  sessionId: string,
) {
  return db
    .select()
    .from(messageLogs)
    .where(and(eq(messageLogs.accountId, accountId), eq(messageLogs.sessionId, sessionId)));
}
