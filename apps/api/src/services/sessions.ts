import { and, count, eq, ne, sql } from "drizzle-orm";
import { sessions, type Db } from "@waapi/db";
import { REDIS_KEY } from "@waapi/shared";
import { config } from "../config.js";
import { defaultJobOptions, redis, sessionCommandsQueue } from "./queues.js";

const missing = () =>
  Object.assign(new Error("Session not found"), { statusCode: 404, code: "NOT_FOUND" });

export async function createSession(
  database: Db,
  accountId: string,
  name: string,
  requestId: string,
) {
  const session = await database.db.transaction(async (tx) => {
    await tx.execute(sql`select id from accounts where id = ${accountId} for update`);
    const accountRows = await tx.execute(
      sql`select id, max_sessions, suspended_at from accounts where id = ${accountId}`,
    );
    const account = accountRows[0] as
      | { id: string; max_sessions: number; suspended_at: Date | null }
      | undefined;
    if (!account) {
      throw Object.assign(new Error("Account not found"), { statusCode: 404, code: "NOT_FOUND" });
    }
    if (account.suspended_at) {
      throw Object.assign(new Error("Account suspended"), { statusCode: 403, code: "FORBIDDEN" });
    }

    const [global] = await tx.select({ value: count() }).from(sessions).where(ne(sessions.status, "logged_out"));
    if ((global?.value ?? 0) >= config.GLOBAL_MAX_SESSIONS) {
      throw Object.assign(new Error("Global session capacity reached"), {
        statusCode: 503,
        code: "GLOBAL_SESSION_CAP",
      });
    }

    const [total] = await tx
      .select({ value: count() })
      .from(sessions)
      .where(and(eq(sessions.accountId, accountId), ne(sessions.status, "logged_out")));
    if ((total?.value ?? 0) >= Number(account.max_sessions)) {
      throw Object.assign(new Error("Account session cap reached"), {
        statusCode: 409,
        code: "ACCOUNT_SESSION_CAP",
      });
    }
    const [row] = await tx.insert(sessions).values({ accountId, name }).returning();
    return row!;
  });

  try {
    await sessionCommandsQueue.add(
      "open-session",
      {
        type: "open-session",
        accountId,
        sessionId: session.id,
        requestId,
      },
      { ...defaultJobOptions, jobId: `open-${session.id}-${Date.now()}` },
    );
  } catch (err) {
    await database.db.delete(sessions).where(eq(sessions.id, session.id));
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      statusCode: 503,
      code: "INTERNAL_ERROR",
    });
  }
  return session;
}

export const listSessions = (database: Db, accountId: string) =>
  database.db.select().from(sessions).where(eq(sessions.accountId, accountId));

export async function getSession(database: Db, accountId: string, id: string) {
  const [row] = await database.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.accountId, accountId)))
    .limit(1);
  if (!row) throw missing();
  return row;
}

export async function deleteSession(database: Db, accountId: string, id: string) {
  await getSession(database, accountId, id);
  await command(database, accountId, id, "logout", "delete");
}

export async function command(
  database: Db,
  accountId: string,
  id: string,
  action: "connect" | "disconnect" | "logout",
  requestId: string,
) {
  await getSession(database, accountId, id);
  const type =
    action === "connect"
      ? "open-session"
      : action === "logout"
        ? "logout-session"
        : "close-session";
  await sessionCommandsQueue.add(
    type,
    { type, accountId, sessionId: id, requestId },
    defaultJobOptions,
  );
}

export async function status(database: Db, accountId: string, id: string) {
  const row = await getSession(database, accountId, id);
  const cached = await redis.get(REDIS_KEY.qr(id));
  let qr: { value: string; updatedAt: string; expiresAt: string } | null = null;
  if (cached) {
    const parsed = JSON.parse(cached) as {
      qr?: string;
      value?: string;
      at?: string;
      updatedAt?: string;
      expiresAt: string;
    };
    qr = {
      value: parsed.value ?? parsed.qr ?? "",
      updatedAt: parsed.updatedAt ?? parsed.at ?? new Date().toISOString(),
      expiresAt: parsed.expiresAt,
    };
  }
  const expired = qr ? new Date(qr.expiresAt) <= new Date() : false;
  const showQr = row.status === "need_scan" && qr && qr.value && !expired;
  return {
    id: row.id,
    status: row.status,
    phoneNumber: row.phoneNumber,
    lastError: row.lastError,
    nodeId: row.nodeId,
    qr: showQr ? qr : null,
    qrExpired: expired || undefined,
  };
}
