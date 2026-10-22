import { and, count, eq, isNull, ne, sql } from "drizzle-orm";
import {
  sessionApiKeys,
  sessions,
  webhookEndpoints,
  type Db,
} from "@waapi/db";
import { REDIS_KEY } from "@waapi/shared";
import { config } from "../config.js";
import { mapLastError, toSessionPublic } from "../lib/session-public.js";
import { defaultJobOptions, redis, sessionCommandsQueue } from "./queues.js";

const missing = () =>
  Object.assign(new Error("Session not found"), { statusCode: 404, code: "NOT_FOUND" });

/** Advisory lock key for global session capacity checks. */
const GLOBAL_SESSION_LOCK = 88112233;

export async function createSession(
  database: Db,
  accountId: string,
  name: string,
  requestId: string,
) {
  const session = await database.db.transaction(async (tx) => {
    await tx.execute(sql`select id from accounts where id = ${accountId} for update`);
    await tx.execute(sql`select pg_advisory_xact_lock(${GLOBAL_SESSION_LOCK})`);

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

    const [global] = await tx
      .select({ value: count() })
      .from(sessions)
      .where(and(ne(sessions.status, "logged_out"), isNull(sessions.deletedAt)));
    if ((global?.value ?? 0) >= config.GLOBAL_MAX_SESSIONS) {
      throw Object.assign(new Error("Global session capacity reached"), {
        statusCode: 503,
        code: "GLOBAL_SESSION_CAP",
      });
    }

    const [total] = await tx
      .select({ value: count() })
      .from(sessions)
      .where(
        and(
          eq(sessions.accountId, accountId),
          ne(sessions.status, "logged_out"),
          isNull(sessions.deletedAt),
        ),
      );
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
  return toSessionPublic(session);
}

export async function listSessions(database: Db, accountId: string) {
  const rows = await database.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.accountId, accountId), isNull(sessions.deletedAt)));
  return rows.map(toSessionPublic);
}

export async function getSession(database: Db, accountId: string, id: string) {
  const [row] = await database.db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.id, id), eq(sessions.accountId, accountId), isNull(sessions.deletedAt)),
    )
    .limit(1);
  if (!row) throw missing();
  return row;
}

export async function getSessionPublic(database: Db, accountId: string, id: string) {
  return toSessionPublic(await getSession(database, accountId, id));
}

export async function renameSession(
  database: Db,
  accountId: string,
  id: string,
  name: string,
) {
  const row = await getSession(database, accountId, id);
  const [updated] = await database.db
    .update(sessions)
    .set({ name, updatedAt: new Date() })
    .where(eq(sessions.id, row.id))
    .returning();
  return toSessionPublic(updated!);
}

/**
 * Soft-delete + enqueue logout. Hard delete of row/keys/webhook happens after
 * worker confirmation (logged_out) via finalizeDeletedSessions.
 */
export async function deleteSession(database: Db, accountId: string, id: string) {
  const row = await getSession(database, accountId, id);
  await database.db
    .update(sessions)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(sessions.id, row.id));
  await sessionCommandsQueue.add(
    "logout-session",
    {
      type: "logout-session",
      accountId,
      sessionId: id,
      requestId: `delete-${id}`,
    },
    { ...defaultJobOptions, jobId: `logout-delete-${id}-${Date.now()}` },
  );
  return { id, accepted: true };
}

/** Hard-delete sessions that are logged_out (or already wiped) with deleted_at set. */
export async function finalizeDeletedSessions(database: Db): Promise<number> {
  const rows = await database.db.execute(sql`
    select id from sessions
    where deleted_at is not null
      and status = 'logged_out'
    limit 50
  `);
  let n = 0;
  for (const row of rows as unknown as Array<{ id: string }>) {
    await database.db.delete(sessionApiKeys).where(eq(sessionApiKeys.sessionId, row.id));
    await database.db.delete(webhookEndpoints).where(eq(webhookEndpoints.sessionId, row.id));
    await database.db.delete(sessions).where(eq(sessions.id, row.id));
    n += 1;
  }
  return n;
}

export async function command(
  database: Db,
  accountId: string,
  id: string,
  action: "connect" | "disconnect" | "logout",
  requestId: string,
) {
  const row = await getSession(database, accountId, id);
  if (action === "connect" && row.status === "logged_out") {
    throw Object.assign(new Error("Session is logged out"), {
      statusCode: 409,
      code: "SESSION_LOGGED_OUT",
    });
  }
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
    lastError: mapLastError(row.lastError),
    qr: showQr ? qr : null,
    qrExpired: expired || undefined,
  };
}
