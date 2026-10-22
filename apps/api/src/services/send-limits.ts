import { eq, sql } from "drizzle-orm";
import { accounts, sessionSendCounters, sessions, type Db } from "@waapi/db";
import {
  SEND_WARMUP_DAYS,
  SEND_WARMUP_PER_DAY,
  SEND_WARMUP_PER_MINUTE,
  getPlan,
} from "@waapi/shared";

function utcDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function utcMinuteKey(d = new Date()): string {
  return d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
}

export type SendLimitCaps = {
  perDay: number;
  perMinute: number;
  warmUp: boolean;
};

export function capsForSession(
  planCode: string,
  sessionCreatedAt: Date,
  now = new Date(),
): SendLimitCaps {
  const plan = getPlan(planCode);
  const ageMs = now.getTime() - sessionCreatedAt.getTime();
  const warmUp = ageMs < SEND_WARMUP_DAYS * 86_400_000;
  if (warmUp) {
    return {
      perDay: Math.min(plan.sendsPerDay, SEND_WARMUP_PER_DAY),
      perMinute: Math.min(plan.sendsPerMinute, SEND_WARMUP_PER_MINUTE),
      warmUp: true,
    };
  }
  return { perDay: plan.sendsPerDay, perMinute: plan.sendsPerMinute, warmUp: false };
}

function limitError(retryAfterSec: number): never {
  throw Object.assign(new Error("Session send limit reached"), {
    statusCode: 429,
    code: "SESSION_SEND_LIMIT",
    after: retryAfterSec,
    retryAfter: retryAfterSec,
  });
}

/**
 * Atomically check + increment per-session minute/day counters.
 * Throws 429 SESSION_SEND_LIMIT with Retry-After when exceeded.
 */
export async function assertAndIncrementSendLimit(
  database: Db,
  accountId: string,
  sessionId: string,
): Promise<SendLimitCaps> {
  const [session] = await database.db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      accountId: sessions.accountId,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session || session.accountId !== accountId) {
    throw Object.assign(new Error("Session not found"), { statusCode: 404, code: "NOT_FOUND" });
  }
  const [acct] = await database.db
    .select({ planCode: accounts.planCode })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  const caps = capsForSession(acct?.planCode ?? "trial", session.createdAt);
  const dayKey = utcDayKey();
  const minuteKey = utcMinuteKey();

  // Upsert counter row then check in one round-trip via raw SQL for atomicity.
  const rows = await database.db.execute(sql`
    insert into session_send_counters (session_id, day_key, day_count, minute_key, minute_count, updated_at)
    values (${sessionId}::uuid, ${dayKey}, 1, ${minuteKey}, 1, now())
    on conflict (session_id) do update set
      day_count = case
        when session_send_counters.day_key = excluded.day_key
          then session_send_counters.day_count + 1
        else 1
      end,
      day_key = excluded.day_key,
      minute_count = case
        when session_send_counters.minute_key = excluded.minute_key
          then session_send_counters.minute_count + 1
        else 1
      end,
      minute_key = excluded.minute_key,
      updated_at = now()
    returning day_count, minute_count
  `);
  const row = rows[0] as { day_count: number; minute_count: number } | undefined;
  const dayCount = Number(row?.day_count ?? 1);
  const minuteCount = Number(row?.minute_count ?? 1);

  if (minuteCount > caps.perMinute) {
    // roll back the excess increment best-effort
    await database.db.execute(sql`
      update session_send_counters
      set minute_count = greatest(minute_count - 1, 0),
          day_count = greatest(day_count - 1, 0),
          updated_at = now()
      where session_id = ${sessionId}::uuid
    `);
    limitError(60);
  }
  if (dayCount > caps.perDay) {
    await database.db.execute(sql`
      update session_send_counters
      set minute_count = greatest(minute_count - 1, 0),
          day_count = greatest(day_count - 1, 0),
          updated_at = now()
      where session_id = ${sessionId}::uuid
    `);
    const now = new Date();
    const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    limitError(Math.max(1, Math.ceil((tomorrow - now.getTime()) / 1000)));
  }
  return caps;
}

export async function getSendUsage(database: Db, accountId: string, sessionId: string) {
  const [session] = await database.db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session || session.accountId !== accountId) {
    throw Object.assign(new Error("Session not found"), { statusCode: 404, code: "NOT_FOUND" });
  }
  const [acct] = await database.db
    .select({ planCode: accounts.planCode })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  const caps = capsForSession(acct?.planCode ?? "trial", session.createdAt);
  const [counter] = await database.db
    .select()
    .from(sessionSendCounters)
    .where(eq(sessionSendCounters.sessionId, sessionId))
    .limit(1);
  const dayKey = utcDayKey();
  const minuteKey = utcMinuteKey();
  return {
    perDay: caps.perDay,
    perMinute: caps.perMinute,
    warmUp: caps.warmUp,
    dayUsed: counter && counter.dayKey === dayKey ? counter.dayCount : 0,
    minuteUsed: counter && counter.minuteKey === minuteKey ? counter.minuteCount : 0,
  };
}
