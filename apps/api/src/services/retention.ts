import { sql } from "drizzle-orm";
import type { Db } from "@waapi/db";
import { config } from "../config.js";

/**
 * Retention purge for high-volume tables.
 * Webhook delivery payloads are purged (null) while metadata rows remain.
 */
export async function purgeRetentionTables(database: Db): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const successHours = config.WEBHOOK_PAYLOAD_PURGE_SUCCESS_HOURS;
  const failedDays = config.WEBHOOK_PAYLOAD_PURGE_FAILED_DAYS;

  const idem = await database.db.execute(sql`
    with d as (
      delete from idempotency_keys
      where expires_at < now()
      returning 1
    )
    select count(*)::int as n from d
  `);
  counts.idempotency_keys = Number((idem[0] as { n: number } | undefined)?.n ?? 0);

  // Purge encrypted bodies only — keep delivery metadata rows.
  const purgedSuccess = await database.db.execute(sql`
    with u as (
      update webhook_deliveries
      set payload = null, updated_at = now()
      where status = 'success'
        and payload is not null
        and updated_at < now() - (${successHours}::text || ' hours')::interval
      returning 1
    )
    select count(*)::int as n from u
  `);
  counts.webhook_payloads_success = Number(
    (purgedSuccess[0] as { n: number } | undefined)?.n ?? 0,
  );

  const purgedFailed = await database.db.execute(sql`
    with u as (
      update webhook_deliveries
      set payload = null, updated_at = now()
      where status in ('dead', 'skipped', 'retrying')
        and payload is not null
        and updated_at < now() - (${failedDays}::text || ' days')::interval
      returning 1
    )
    select count(*)::int as n from u
  `);
  counts.webhook_payloads_failed = Number(
    (purgedFailed[0] as { n: number } | undefined)?.n ?? 0,
  );

  const deliveries = await database.db.execute(sql`
    with d as (
      delete from webhook_deliveries
      where created_at < now() - interval '30 days'
        and payload is null
      returning 1
    )
    select count(*)::int as n from d
  `);
  counts.webhook_deliveries = Number((deliveries[0] as { n: number } | undefined)?.n ?? 0);

  const outbox = await database.db.execute(sql`
    with d as (
      delete from webhook_outbox
      where processed_at is not null
        and processed_at < now() - interval '7 days'
      returning 1
    )
    select count(*)::int as n from d
  `);
  counts.webhook_outbox = Number((outbox[0] as { n: number } | undefined)?.n ?? 0);

  const outbound = await database.db.execute(sql`
    with d as (
      delete from outbound_messages
      where status in ('sent', 'failed')
        and updated_at < now() - interval '30 days'
      returning 1
    )
    select count(*)::int as n from d
  `);
  counts.outbound_messages = Number((outbound[0] as { n: number } | undefined)?.n ?? 0);

  const audit = await database.db.execute(sql`
    with d as (
      delete from security_audit_log
      where created_at < now() - interval '90 days'
      returning 1
    )
    select count(*)::int as n from d
  `);
  counts.security_audit_log = Number((audit[0] as { n: number } | undefined)?.n ?? 0);

  return counts;
}

/** Test helper: purge payloads with custom age cutoffs (seconds). */
export async function purgeWebhookPayloadsForTest(
  database: Db,
  opts: { successOlderThanSeconds: number; failedOlderThanSeconds: number },
): Promise<number> {
  const a = await database.db.execute(sql`
    with u as (
      update webhook_deliveries
      set payload = null, updated_at = now()
      where status = 'success'
        and payload is not null
        and updated_at < now() - (${opts.successOlderThanSeconds}::text || ' seconds')::interval
      returning 1
    )
    select count(*)::int as n from u
  `);
  const b = await database.db.execute(sql`
    with u as (
      update webhook_deliveries
      set payload = null, updated_at = now()
      where status in ('dead', 'skipped', 'retrying')
        and payload is not null
        and updated_at < now() - (${opts.failedOlderThanSeconds}::text || ' seconds')::interval
      returning 1
    )
    select count(*)::int as n from u
  `);
  return (
    Number((a[0] as { n: number } | undefined)?.n ?? 0) +
    Number((b[0] as { n: number } | undefined)?.n ?? 0)
  );
}
