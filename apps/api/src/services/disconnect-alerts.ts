import { and, eq, isNull, sql } from "drizzle-orm";
import { accounts, sessions, users, type Db } from "@waapi/db";
import { config } from "../config.js";
import { emailQueue, defaultJobOptions } from "./queues.js";

const DEDUPE_MS = 6 * 60 * 60_000;

export type DisconnectAlertReason =
  | "disconnected"
  | "logged_out"
  | "connection_replaced";

/**
 * Enqueue a disconnect alert email to the account owner.
 * Deduped 6h per session; respects disconnect_alerts_opt_out.
 */
export async function maybeEnqueueDisconnectAlert(
  database: Db,
  accountId: string,
  sessionId: string,
  reason: DisconnectAlertReason,
): Promise<boolean> {
  const [acct] = await database.db
    .select({
      optOut: accounts.disconnectAlertsOptOut,
      name: accounts.name,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!acct || acct.optOut) return false;

  const [sess] = await database.db
    .select({
      id: sessions.id,
      name: sessions.name,
      lastDisconnectAlertAt: sessions.lastDisconnectAlertAt,
    })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId)))
    .limit(1);
  if (!sess) return false;
  if (
    sess.lastDisconnectAlertAt &&
    Date.now() - sess.lastDisconnectAlertAt.getTime() < DEDUPE_MS
  ) {
    return false;
  }

  // Claim dedupe window first so concurrent status updates don't double-send.
  const claimed = await database.db.execute(sql`
    update sessions
    set last_disconnect_alert_at = now(), updated_at = now()
    where id = ${sessionId}::uuid
      and account_id = ${accountId}::uuid
      and (
        last_disconnect_alert_at is null
        or last_disconnect_alert_at < now() - interval '6 hours'
      )
    returning id
  `);
  if (!claimed[0]) return false;

  const [owner] = await database.db
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.accountId, accountId),
        eq(users.role, "owner"),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);
  if (!owner?.email) {
    // Fall back to any active user on the account.
    const [any] = await database.db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.accountId, accountId), isNull(users.disabledAt)))
      .limit(1);
    if (!any?.email) return false;
    await enqueue(any.email, sess.name, reason);
    return true;
  }
  await enqueue(owner.email, sess.name, reason);
  return true;
}

async function enqueue(to: string, sessionName: string, reason: DisconnectAlertReason) {
  const brand = config.BRAND_NAME;
  await emailQueue.add(
    "session-disconnect",
    {
      to,
      kind: "session_disconnect",
      subject: `${brand}: session ${reason.replace(/_/g, " ")}`,
      text: [
        `Your ${brand} session "${sessionName}" is ${reason.replace(/_/g, " ")}.`,
        "",
        "Open the dashboard to reconnect or scan a new QR code.",
        "You can turn off these emails in account settings.",
      ].join("\n"),
      sessionName,
      reason,
    },
    { ...defaultJobOptions, jobId: `disc-alert-${to}-${Date.now()}` },
  );
}

/** Map session status / lastError into an alert reason, or null if none. */
export function alertReasonFromStatus(
  status: string,
  lastError?: string | null,
): DisconnectAlertReason | null {
  if (status === "logged_out") return "logged_out";
  if (lastError === "connection_replaced" || status === "error" && lastError?.includes("connection_replaced")) {
    return "connection_replaced";
  }
  if (status === "disconnected") return "disconnected";
  return null;
}
