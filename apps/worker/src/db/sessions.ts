import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { SessionStatus } from "@waapi/shared";
import type { Db } from "./client.js";
import { accounts, sessions } from "./schema.js";

const ACTIVE_STATUSES: SessionStatus[] = [
  "need_scan",
  "connecting",
  "connected",
  "disconnected",
  "error",
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
    .where(and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId)))
    .returning();
  return row ?? null;
}

export async function listSessionsToLoad(db: Db["db"], limit: number) {
  return db
    .select()
    .from(sessions)
    .where(inArray(sessions.status, ACTIVE_STATUSES))
    .limit(limit);
}

export async function wipeAuthForSession(db: Db["db"], sessionId: string): Promise<void> {
  const { waAuthCreds, waAuthKeys } = await import("./schema.js");
  await db.delete(waAuthKeys).where(eq(waAuthKeys.sessionId, sessionId));
  await db.delete(waAuthCreds).where(eq(waAuthCreds.sessionId, sessionId));
}
