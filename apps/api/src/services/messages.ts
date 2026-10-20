import { and, desc, eq, lt } from "drizzle-orm";
import { messageLogs, outboundMessages, type Db } from "@waapi/db";

export async function listMessages(
  database: Db,
  accountId: string,
  options: { sessionId?: string; cursor?: string; limit?: number },
) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const conditions = [eq(messageLogs.accountId, accountId)];
  if (options.sessionId) conditions.push(eq(messageLogs.sessionId, options.sessionId));
  if (options.cursor) {
    conditions.push(
      lt(
        messageLogs.createdAt,
        new Date(Buffer.from(options.cursor, "base64url").toString("utf8")),
      ),
    );
  }
  const rows = await database.db
    .select()
    .from(messageLogs)
    .where(and(...conditions))
    .orderBy(desc(messageLogs.createdAt))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => ({
    id: row.id,
    accountId: row.accountId,
    sessionId: row.sessionId,
    direction: row.direction,
    remoteJid: row.remoteJid,
    messageId: row.messageId,
    fromMe: row.fromMe,
    messageType: row.messageType,
    /** Present when send failed ambiguously — see docs on delivery_unknown. */
    error: row.error,
    createdAt: row.createdAt,
  }));

  // Also surface failed outbound rows that may not have a message_log yet (race),
  // keyed by outbound id when error is delivery_unknown.
  if (options.sessionId) {
    const failed = await database.db
      .select({
        id: outboundMessages.id,
        sessionId: outboundMessages.sessionId,
        toJid: outboundMessages.toJid,
        error: outboundMessages.error,
        createdAt: outboundMessages.createdAt,
      })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.accountId, accountId),
          eq(outboundMessages.sessionId, options.sessionId),
          eq(outboundMessages.status, "failed"),
        ),
      )
      .orderBy(desc(outboundMessages.createdAt))
      .limit(20);
    const seen = new Set(items.map((i) => i.messageId));
    for (const f of failed) {
      if (!f.error || seen.has(f.id)) continue;
      items.push({
        id: f.id,
        accountId,
        sessionId: f.sessionId,
        direction: "outbound",
        remoteJid: f.toJid,
        messageId: f.id,
        fromMe: true,
        messageType: "conversation",
        error: f.error,
        createdAt: f.createdAt,
      });
    }
    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  const page = items.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor:
      hasMore && last ? Buffer.from(last.createdAt.toISOString()).toString("base64url") : null,
  };
}
