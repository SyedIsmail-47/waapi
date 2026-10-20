import { and, desc, eq, lt } from "drizzle-orm";
import { messageLogs, type Db } from "@waapi/db";

export async function listMessages(database: Db, accountId: string, options: { sessionId?: string; cursor?: string; limit?: number }) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const conditions = [eq(messageLogs.accountId, accountId)];
  if (options.sessionId) conditions.push(eq(messageLogs.sessionId, options.sessionId));
  if (options.cursor) conditions.push(lt(messageLogs.createdAt, new Date(Buffer.from(options.cursor, "base64url").toString("utf8"))));
  const rows = await database.db.select().from(messageLogs).where(and(...conditions)).orderBy(desc(messageLogs.createdAt)).limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? Buffer.from(last.createdAt.toISOString()).toString("base64url") : null };
}
