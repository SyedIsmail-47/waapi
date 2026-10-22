import { Queue } from "bullmq";
import { and, eq, isNull, sql } from "drizzle-orm";
import { accounts, users } from "@waapi/db";
import { QUEUE_EMAIL } from "@waapi/shared";
import type { Redis } from "ioredis";
import type { Db } from "../db/client.js";

const DEDUPE_HOURS = 6;

export type DisconnectAlertReason = "disconnected" | "logged_out" | "connection_replaced";

let emailQueue: Queue | null = null;

function getEmailQueue(redis: Redis): Queue {
  if (!emailQueue) {
    emailQueue = new Queue(QUEUE_EMAIL, {
      connection: redis,
      defaultJobOptions: {
        removeOnComplete: { age: 60, count: 100 },
        removeOnFail: { age: 300, count: 50 },
      },
    });
  }
  return emailQueue;
}

export function alertReasonFromStatus(
  status: string,
  lastError?: string | null,
): DisconnectAlertReason | null {
  if (status === "logged_out") return "logged_out";
  if (lastError === "connection_replaced" || lastError === "PHONE_IN_USE") {
    // PHONE_IN_USE is not a disconnect alert reason
  }
  if (lastError === "connection_replaced") return "connection_replaced";
  if (status === "error" && lastError?.includes("connection_replaced")) {
    return "connection_replaced";
  }
  if (status === "disconnected") return "disconnected";
  return null;
}

export async function maybeEnqueueDisconnectAlert(
  db: Db["db"],
  redis: Redis,
  accountId: string,
  sessionId: string,
  reason: DisconnectAlertReason,
  brandName: string,
): Promise<boolean> {
  const [acct] = await db
    .select({ optOut: accounts.disconnectAlertsOptOut })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!acct || acct.optOut) return false;

  const claimed = await db.execute(sql`
    update sessions
    set last_disconnect_alert_at = now(), updated_at = now()
    where id = ${sessionId}::uuid
      and account_id = ${accountId}::uuid
      and (
        last_disconnect_alert_at is null
        or last_disconnect_alert_at < now() - (${DEDUPE_HOURS}::text || ' hours')::interval
      )
    returning id, name
  `);
  const row = claimed[0] as { id: string; name: string } | undefined;
  if (!row) return false;

  const [owner] = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.accountId, accountId), eq(users.role, "owner"), isNull(users.disabledAt)))
    .limit(1);
  const to =
    owner?.email ??
    (
      await db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.accountId, accountId), isNull(users.disabledAt)))
        .limit(1)
    )[0]?.email;
  if (!to) return false;

  await getEmailQueue(redis).add(
    "session-disconnect",
    {
      to,
      kind: "session_disconnect",
      sessionName: row.name,
      reason,
      subject: `${brandName}: session ${reason.replace(/_/g, " ")}`,
    },
    { jobId: `disc-${sessionId}-${Date.now()}` },
  );
  return true;
}
