import { and, desc, eq, isNull, like, or, sql } from "drizzle-orm";
import {
  accounts,
  personalAccessTokens,
  securityAuditLog,
  sessionApiKeys,
  sessions,
  users,
  webhookDeliveries,
  type Db,
} from "@waapi/db";
import { setPlanManual } from "./billing/index.js";
import { createInviteCode } from "./invites.js";
import { defaultJobOptions, sessionCommandsQueue } from "./queues.js";

const db = (value: Db) => value.db;

async function audit(
  database: Db,
  eventType: string,
  meta: Record<string, unknown>,
  accountId?: string,
  userId?: string,
) {
  await db(database).insert(securityAuditLog).values({
    accountId,
    userId,
    eventType,
    meta,
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function findUser(database: Db, query: string) {
  const q = query.trim().toLowerCase();
  const filters = [
    sql`lower(${users.email}) = ${q}`,
    like(sql`lower(${users.email})`, `%${q}%`),
  ];
  if (UUID_RE.test(query.trim())) {
    filters.push(eq(users.id, query.trim()), eq(accounts.id, query.trim()));
  }
  const rows = await db(database)
    .select({
      userId: users.id,
      email: users.email,
      accountId: users.accountId,
      role: users.role,
      disabledAt: users.disabledAt,
      accountName: accounts.name,
      planCode: accounts.planCode,
      suspendedAt: accounts.suspendedAt,
    })
    .from(users)
    .innerJoin(accounts, eq(accounts.id, users.accountId))
    .where(or(...filters))
    .limit(20);
  // Never return password hashes or message content.
  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    accountId: r.accountId,
    role: r.role,
    disabledAt: r.disabledAt?.toISOString() ?? null,
    accountName: r.accountName,
    planCode: r.planCode,
    suspendedAt: r.suspendedAt?.toISOString() ?? null,
  }));
}

export async function suspendAccount(database: Db, accountId: string, suspend: boolean) {
  const [row] = await db(database)
    .update(accounts)
    .set({ suspendedAt: suspend ? new Date() : null })
    .where(eq(accounts.id, accountId))
    .returning({ id: accounts.id });
  if (!row) {
    throw Object.assign(new Error("Account not found"), { statusCode: 404, code: "NOT_FOUND" });
  }
  await audit(database, suspend ? "admin.account_suspend" : "admin.account_unsuspend", {
    accountId,
  }, accountId);
}

export async function adminSetPlan(database: Db, accountId: string, planCode: string) {
  await setPlanManual(database, accountId, planCode, "active");
  await audit(database, "admin.set_plan", { accountId, planCode }, accountId);
}

export async function revokeAllKeys(database: Db, accountId: string) {
  await db(database)
    .update(personalAccessTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(personalAccessTokens.accountId, accountId), isNull(personalAccessTokens.revokedAt)));
  await db(database)
    .update(sessionApiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessionApiKeys.accountId, accountId), isNull(sessionApiKeys.revokedAt)));
  await audit(database, "admin.revoke_keys", { accountId }, accountId);
}

export async function forceSessionLogout(database: Db, sessionId: string) {
  const [row] = await db(database)
    .select({ id: sessions.id, accountId: sessions.accountId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) {
    throw Object.assign(new Error("Session not found"), { statusCode: 404, code: "NOT_FOUND" });
  }
  await sessionCommandsQueue.add(
    "logout-session",
    {
      type: "logout-session",
      accountId: row.accountId,
      sessionId: row.id,
      requestId: `admin-logout-${row.id}`,
    },
    { ...defaultJobOptions, jobId: `admin-logout-${row.id}-${Date.now()}` },
  );
  await audit(
    database,
    "admin.force_session_logout",
    { sessionId: row.id },
    row.accountId,
  );
}

/** Failing webhooks — metadata only (no payload bodies). */
export async function listFailingWebhooks(database: Db, limit = 50) {
  const rows = await db(database)
    .select({
      id: webhookDeliveries.id,
      accountId: webhookDeliveries.accountId,
      sessionId: webhookDeliveries.sessionId,
      eventType: webhookDeliveries.eventType,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      lastError: webhookDeliveries.lastError,
      responseCode: webhookDeliveries.responseCode,
      createdAt: webhookDeliveries.createdAt,
    })
    .from(webhookDeliveries)
    .where(or(eq(webhookDeliveries.status, "dead"), eq(webhookDeliveries.status, "retrying")))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    // Strip anything that could look like a body
    lastError: r.lastError?.slice(0, 200) ?? null,
  }));
}

export async function adminCreateInvite(
  database: Db,
  opts: { expiresInHours?: number; note?: string } = {},
) {
  const created = await createInviteCode(database, opts);
  await audit(database, "admin.invite_created", {
    inviteId: created.id,
    codePrefix: created.codePrefix,
  });
  return created;
}
