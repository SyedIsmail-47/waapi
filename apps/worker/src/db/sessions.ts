import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { SessionStatus } from "@waapi/shared";
import type { Db } from "./client.js";
import { accounts, sessions, waAuthCreds, waAuthKeys } from "./schema.js";

/**
 * Statuses eligible for boot reload.
 * Excludes terminal `logged_out` and permanent `error` (no auto-reload).
 */
const BOOT_LOAD_STATUSES: SessionStatus[] = [
  "need_scan",
  "connecting",
  "connected",
  "disconnected",
];

export async function getSessionForAccount(
  db: Db["db"],
  accountId: string,
  sessionId: string,
) {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function countAccountSessions(db: Db["db"], accountId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sessions)
    .where(and(eq(sessions.accountId, accountId), ne(sessions.status, "logged_out")));
  return rows[0]?.count ?? 0;
}

export async function getAccount(db: Db["db"], accountId: string) {
  const rows = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  return rows[0] ?? null;
}

export type CreateSessionInput = {
  accountId: string;
  name: string;
  maxSessionsPerNode: number;
  currentNodeSessionCount: number;
};

export async function createSessionTransactional(
  db: Db["db"],
  input: CreateSessionInput,
) {
  return db.transaction(async (tx) => {
    // Serialize creates per account so concurrent Promise.all cannot overshoot maxSessions.
    await tx.execute(sql`select id from accounts where id = ${input.accountId} for update`);
    const accountRows = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, input.accountId))
      .limit(1);
    const account = accountRows[0];
    if (!account) {
      throw new Error("ACCOUNT_NOT_FOUND");
    }

    const countRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(eq(sessions.accountId, input.accountId), ne(sessions.status, "logged_out")));
    const count = countRows[0]?.count ?? 0;
    if (count >= account.maxSessions) {
      throw new Error("ACCOUNT_SESSION_CAP");
    }
    if (input.currentNodeSessionCount >= input.maxSessionsPerNode) {
      throw new Error("NODE_SESSION_CAP");
    }

    const [row] = await tx
      .insert(sessions)
      .values({
        accountId: input.accountId,
        name: input.name,
        status: "need_scan",
      })
      .returning();
    return row!;
  });
}

/**
 * Update session status. Never overwrites a terminal `logged_out` row
 * (returns null if the session is already logged_out).
 */
export async function updateSessionStatus(
  db: Db["db"],
  accountId: string,
  sessionId: string,
  status: SessionStatus,
  patch: { lastError?: string | null; phoneNumber?: string | null } = {},
) {
  const [row] = await db
    .update(sessions)
    .set({
      status,
      lastError: patch.lastError === undefined ? undefined : patch.lastError,
      phoneNumber: patch.phoneNumber === undefined ? undefined : patch.phoneNumber,
      lastConnectedAt: status === "connected" ? new Date() : undefined,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.accountId, accountId),
        ne(sessions.status, "logged_out"),
      ),
    )
    .returning();
  return row ?? null;
}

/** Prefer crash-recovery of connecting/connected. Excludes `error` and `logged_out`. */
export async function listSessionsToLoad(db: Db["db"], limit: number) {
  return db
    .select()
    .from(sessions)
    .where(inArray(sessions.status, BOOT_LOAD_STATUSES))
    .orderBy(
      sql`case when ${sessions.status} in ('connecting','connected') then 0 else 1 end`,
      asc(sessions.updatedAt),
    )
    .limit(limit);
}

export async function wipeAuthForSession(db: Db["db"], sessionId: string): Promise<void> {
  await db.delete(waAuthKeys).where(eq(waAuthKeys.sessionId, sessionId));
  await db.delete(waAuthCreds).where(eq(waAuthCreds.sessionId, sessionId));
}

/** Wipe auth + set logged_out in a single transaction. */
export async function markLoggedOutAndWipeAuth(
  db: Db["db"],
  accountId: string,
  sessionId: string,
) {
  return db.transaction(async (tx) => {
    await tx.delete(waAuthKeys).where(eq(waAuthKeys.sessionId, sessionId));
    await tx.delete(waAuthCreds).where(eq(waAuthCreds.sessionId, sessionId));
    const [row] = await tx
      .update(sessions)
      .set({
        status: "logged_out",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.accountId, accountId),
          ne(sessions.status, "logged_out"),
        ),
      )
      .returning();
    return row ?? null;
  });
}

/**
 * After logout confirmation: if API marked deleted_at, remove session row
 * (keys/webhook cascade or cleaned by API finalizeDeletedSessions).
 */
export async function hardDeleteIfSoftDeleted(
  db: Db["db"],
  accountId: string,
  sessionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: sessions.id, deletedAt: sessions.deletedAt })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId)))
    .limit(1);
  if (!row?.deletedAt) return false;
  await db.delete(sessions).where(eq(sessions.id, sessionId));
  return true;
}

/** Boot sweep: delete orphaned auth rows for any session already logged_out. */
export async function sweepAuthForLoggedOutSessions(db: Db["db"]): Promise<number> {
  const loggedOut = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.status, "logged_out"));
  if (loggedOut.length === 0) return 0;
  const ids = loggedOut.map((r) => r.id);
  await db.delete(waAuthKeys).where(inArray(waAuthKeys.sessionId, ids));
  await db.delete(waAuthCreds).where(inArray(waAuthCreds.sessionId, ids));
  return ids.length;
}
