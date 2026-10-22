import { and, eq, sql } from "drizzle-orm";
import { Gauge, register } from "prom-client";
import { webhookEndpoints, webhookOutbox, type Db } from "@waapi/db";
import { enqueueDelivery } from "../services/webhooks/index.js";
import { insertEncryptedDelivery } from "../services/webhooks/deliveries.js";
import { decryptOutboxPayloadJson } from "../lib/payload-crypto.js";
import { webhookDeliveryQueue } from "../services/queues.js";

const MAX_ATTEMPTS = 5;

function gauge(name: string, help: string): Gauge {
  const existing = register.getSingleMetric(name);
  if (existing) return existing as Gauge;
  return new Gauge({ name, help, registers: [register] });
}

const outboxDepthGauge = gauge("waapi_webhook_outbox_depth", "Pending outbox rows ready to claim");
const outboxDeadGauge = gauge("waapi_webhook_outbox_dead", "Dead-letter outbox rows");
const outboxOldestPendingAgeGauge = gauge(
  "waapi_webhook_outbox_oldest_pending_age_seconds",
  "Age in seconds of the oldest pending outbox row (0 if none)",
);

type ClaimedOutbox = {
  id: string;
  account_id: string;
  session_id: string;
  event_type: (typeof webhookOutbox.$inferSelect)["eventType"];
  payload: Record<string, unknown> | null;
  attempts: number;
};

type ClaimResult =
  | { status: "empty" }
  | { status: "skipped" }
  | { status: "failed" }
  | { status: "delivered"; deliveryId: string };

function backoffSeconds(attempts: number): number {
  return Math.min(300, 2 ** attempts);
}

async function markOutboxFailure(
  tx: { execute: Db["db"]["execute"] },
  row: ClaimedOutbox,
  errorCode: string,
): Promise<void> {
  const attempts = Number(row.attempts) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await tx.execute(sql`
      update webhook_outbox
      set
        attempts = ${attempts},
        last_error = ${errorCode},
        status = 'dead',
        payload = null,
        next_attempt_at = null
      where id = ${row.id}::uuid
    `);
    return;
  }
  const delay = backoffSeconds(attempts);
  await tx.execute(sql`
    update webhook_outbox
    set
      attempts = ${attempts},
      last_error = ${errorCode},
      next_attempt_at = now() + (${String(delay)}::text || ' seconds')::interval
    where id = ${row.id}::uuid
  `);
}

/**
 * Claim one due pending outbox row with FOR UPDATE SKIP LOCKED, then
 * decrypt → insert encrypted delivery → DELETE outbox in the same transaction.
 * Decrypt/parse/insert failures never delete the row; they retry then go dead.
 */
async function claimAndProcessOne(database: Db): Promise<ClaimResult> {
  return database.db.transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      select id, account_id, session_id, event_type, payload, attempts
      from webhook_outbox
      where status = 'pending'
        and processed_at is null
        and payload is not null
        and (next_attempt_at is null or next_attempt_at <= now())
      order by created_at
      limit 1
      for update skip locked
    `);
    const row = claimed[0] as ClaimedOutbox | undefined;
    if (!row) return { status: "empty" };

    const [endpoint] = await tx
      .select()
      .from(webhookEndpoints)
      .where(
        and(eq(webhookEndpoints.sessionId, row.session_id), eq(webhookEndpoints.enabled, true)),
      )
      .limit(1);
    if (!endpoint) {
      await tx.delete(webhookOutbox).where(eq(webhookOutbox.id, row.id));
      return { status: "skipped" };
    }

    try {
      if (!row.payload) {
        await markOutboxFailure(tx, row, "empty_payload");
        return { status: "failed" };
      }
      let plaintextJson: string;
      try {
        plaintextJson = decryptOutboxPayloadJson(row.payload, row.id);
      } catch {
        await markOutboxFailure(tx, row, "decrypt_failed");
        return { status: "failed" };
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(plaintextJson) as Record<string, unknown>;
      } catch {
        await markOutboxFailure(tx, row, "json_parse_failed");
        return { status: "failed" };
      }

      const deliveryId = await insertEncryptedDelivery(tx, {
        endpointId: endpoint.id,
        accountId: row.account_id,
        sessionId: row.session_id,
        eventType: row.event_type,
        payload,
      });
      await tx.delete(webhookOutbox).where(eq(webhookOutbox.id, row.id));
      return { status: "delivered", deliveryId };
    } catch {
      await markOutboxFailure(tx, row, "insert_failed");
      return { status: "failed" };
    }
  });
}

async function processOutboxRows(database: Db): Promise<number> {
  let processed = 0;
  const deliveryIds: string[] = [];
  for (let i = 0; i < 100; i++) {
    const result = await claimAndProcessOne(database);
    if (result.status === "empty") break;
    if (result.status === "delivered") {
      deliveryIds.push(result.deliveryId);
      processed += 1;
    }
  }
  // BullMQ enqueue happens ONLY after the transaction that created the delivery
  // has committed (claimAndProcessOne returns after commit).
  for (const deliveryId of deliveryIds) {
    await enqueueDelivery(deliveryId);
  }
  return processed;
}

const ACTIVE_JOB_STATES = new Set([
  "waiting",
  "active",
  "delayed",
  "paused",
  "prioritized",
  "waiting-children",
]);

/**
 * Re-enqueue webhook_deliveries still `pending` for >60s with no active BullMQ job
 * (recovers crash between commit and enqueue).
 */
export async function sweepStalePendingDeliveries(database: Db): Promise<number> {
  const rows = await database.db.execute(sql`
    select id
    from webhook_deliveries
    where status = 'pending'
      and created_at < now() - interval '60 seconds'
    order by created_at
    limit 100
  `);
  let enqueued = 0;
  for (const raw of rows) {
    const id = (raw as { id: string }).id;
    const job = await webhookDeliveryQueue.getJob(id);
    if (job) {
      const state = await job.getState();
      if (ACTIVE_JOB_STATES.has(state)) continue;
    }
    await enqueueDelivery(id);
    enqueued += 1;
  }
  return enqueued;
}

export async function collectOutboxStats(database: Db): Promise<{
  depth: number;
  dead: number;
  oldestPendingAgeSec: number;
}> {
  const [depthRow] = await database.db.execute(sql`
    select count(*)::int as n
    from webhook_outbox
    where status = 'pending'
      and processed_at is null
      and payload is not null
      and (next_attempt_at is null or next_attempt_at <= now())
  `);
  const [deadRow] = await database.db.execute(sql`
    select count(*)::int as n from webhook_outbox where status = 'dead'
  `);
  const [oldestRow] = await database.db.execute(sql`
    select coalesce(
      extract(epoch from (now() - min(created_at)))::int,
      0
    ) as age
    from webhook_outbox
    where status = 'pending' and processed_at is null
  `);
  const depth = Number((depthRow as { n: number } | undefined)?.n ?? 0);
  const dead = Number((deadRow as { n: number } | undefined)?.n ?? 0);
  const oldestPendingAgeSec = Number((oldestRow as { age: number } | undefined)?.age ?? 0);
  outboxDepthGauge.set(depth);
  outboxDeadGauge.set(dead);
  outboxOldestPendingAgeGauge.set(oldestPendingAgeSec);
  // Payload-free operational log.
  console.log(
    JSON.stringify({
      msg: "outbox_stats",
      depth,
      dead,
      oldestPendingAgeSec,
    }),
  );
  return { depth, dead, oldestPendingAgeSec };
}

/**
 * Poll unprocessed outbox rows: decrypt → insert encrypted delivery → DELETE
 * outbox row in one transaction, then enqueue BullMQ outside the txn.
 */
export function startOutboxPoller(database: Db): NodeJS.Timeout {
  let running = false;
  let tick = 0;
  return setInterval(async () => {
    if (running) return;
    running = true;
    tick += 1;
    try {
      await processOutboxRows(database);
      if (tick % 15 === 0) {
        await sweepStalePendingDeliveries(database);
        await collectOutboxStats(database);
      }
    } finally {
      running = false;
    }
  }, 1_000);
}

/** One-shot poll for tests (same semantics as the timer). */
export async function pollOutboxOnce(database: Db): Promise<number> {
  return processOutboxRows(database);
}
