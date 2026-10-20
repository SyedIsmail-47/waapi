import { DelayedError, Worker, type Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { outboundMessages } from "@waapi/db";
import { QUEUE_SEND_TEXT, sendTextJobSchema } from "@waapi/shared";
import type { Redis } from "ioredis";
import type { Db } from "../db/client.js";
import { insertMessageLog } from "../db/message-logs.js";
import { getSessionForAccount } from "../db/sessions.js";
import { enqueueWebhookOutbox } from "../db/webhook-outbox.js";
import type { Logger } from "../logger.js";
import type { SessionManager } from "../session/manager.js";

const SEND_MIN_INTERVAL_MS = Number(process.env.SEND_MIN_INTERVAL_MS ?? 800);
const PRE_SEND_RETRYABLE = new Set([
  "SESSION_NOT_CONNECTED",
  "SESSION_NOT_ON_NODE",
  "SESSION_NOT_FOUND_FOR_ACCOUNT",
  "SEND_IN_PROGRESS",
]);

/** Atomically claim a queued outbound row for sending. Exported for unit tests. */
export async function claimOutboundForSend(
  db: Db["db"],
  messageId: string,
): Promise<{ status: "claimed" | "already_sent" | "busy" | "missing" | "failed" }> {
  const claimed = await db.execute(sql`
    update outbound_messages
    set status = 'sending', updated_at = now()
    where id = ${messageId}::uuid and status = 'queued'
    returning id
  `);
  if (claimed[0]) return { status: "claimed" };

  const [row] = await db
    .select({
      status: outboundMessages.status,
      providerMessageId: outboundMessages.providerMessageId,
    })
    .from(outboundMessages)
    .where(eq(outboundMessages.id, messageId))
    .limit(1);
  if (!row) return { status: "missing" };
  if (row.status === "sent" || row.providerMessageId) return { status: "already_sent" };
  if (row.status === "failed") return { status: "failed" };
  return { status: "busy" };
}

async function markRedacted(
  job: Job,
  payload: Record<string, unknown>,
): Promise<void> {
  await job.updateData({ ...payload, text: undefined, redacted: true });
}

/**
 * Redis token-bucket + moveToDelayed (no sleep in the processor).
 * Returns delayMs > 0 if the job should be deferred.
 */
export async function sessionThrottleDelay(
  redis: Redis,
  sessionId: string,
  minIntervalMs = SEND_MIN_INTERVAL_MS,
): Promise<number> {
  const key = `waapi:send:throttle:${sessionId}`;
  const now = Date.now();
  const last = Number((await redis.get(key)) ?? "0");
  const wait = last + minIntervalMs - now;
  if (wait > 0) return wait + Math.floor(Math.random() * 200);
  await redis.set(key, String(now), "PX", minIntervalMs * 4);
  return 0;
}

export function startSendTextWorker(args: {
  connection: Redis;
  db: Db["db"];
  manager: SessionManager;
  log: Logger;
}): Worker {
  const { connection, db, manager, log } = args;

  return new Worker(
    QUEUE_SEND_TEXT,
    async (job) => {
      const payload = sendTextJobSchema.parse(job.data);
      if (payload.redacted) {
        throw new Error("SEND_BODY_MISSING");
      }
      const text = payload.text;
      if (text == null || text === "") {
        // Recover from DB for sweep / lost job body
        const [row] = await db
          .select({ bodyText: outboundMessages.bodyText })
          .from(outboundMessages)
          .where(eq(outboundMessages.id, payload.messageId!))
          .limit(1);
        if (!row?.bodyText) throw new Error("SEND_BODY_MISSING");
        (payload as { text: string }).text = row.bodyText;
      }
      const sendBody = (payload.text as string) ?? text;
      if (sendBody == null) throw new Error("SEND_BODY_MISSING");
      if (!payload.messageId) throw new Error("SEND_MESSAGE_ID_REQUIRED");

      const delay = await sessionThrottleDelay(connection, payload.sessionId);
      if (delay > 0) {
        await job.moveToDelayed(Date.now() + delay, job.token);
        throw new DelayedError();
      }

      const claim = await claimOutboundForSend(db, payload.messageId);
      if (claim.status === "already_sent") {
        await markRedacted(job, payload as unknown as Record<string, unknown>);
        return { skipped: true, reason: "already_sent" };
      }
      if (claim.status === "busy") throw new Error("SEND_IN_PROGRESS");
      if (claim.status === "missing" || claim.status === "failed") {
        throw new Error(`SEND_CLAIM_${claim.status.toUpperCase()}`);
      }

      try {
        const session = await getSessionForAccount(db, payload.accountId, payload.sessionId);
        if (!session) throw new Error("SESSION_NOT_FOUND_FOR_ACCOUNT");
        if (session.status !== "connected") throw new Error("SESSION_NOT_CONNECTED");
        const client = manager.getClient(payload.sessionId);
        if (!client) throw new Error("SESSION_NOT_ON_NODE");

        let result: { messageId: string; remoteJid: string };
        try {
          result = await client.sendText(payload.to, sendBody);
        } catch (sendErr) {
          // WhatsApp send errors are NOT auto-retried — ambiguous delivery.
          const errMsg =
            sendErr instanceof Error && /timeout|unknown|ack/i.test(sendErr.message)
              ? "delivery_unknown"
              : sendErr instanceof Error
                ? sendErr.message
                : "delivery_unknown";
          await db
            .update(outboundMessages)
            .set({
              status: "failed",
              error: errMsg,
              bodyText: null,
              updatedAt: new Date(),
            })
            .where(eq(outboundMessages.id, payload.messageId));
          await markRedacted(job, payload as unknown as Record<string, unknown>);
          return { failed: true, error: errMsg };
        }

        // Mark sent FIRST so post-send failures cannot trigger a resend.
        await db
          .update(outboundMessages)
          .set({
            status: "sent",
            providerMessageId: result.messageId,
            bodyText: null,
            updatedAt: new Date(),
          })
          .where(
            and(eq(outboundMessages.id, payload.messageId), eq(outboundMessages.status, "sending")),
          );

        await markRedacted(job, payload as unknown as Record<string, unknown>);

        // Post-send side effects — never throw out to BullMQ as retryable send.
        try {
          await insertMessageLog(db, {
            accountId: payload.accountId,
            sessionId: payload.sessionId,
            direction: "outbound",
            remoteJid: result.remoteJid,
            messageId: result.messageId,
            fromMe: true,
            messageType: "conversation",
          });
          await enqueueWebhookOutbox(db, {
            accountId: payload.accountId,
            sessionId: payload.sessionId,
            eventType: "message.sent",
            payload: {
              id: crypto.randomUUID(),
              type: "message.sent",
              accountId: payload.accountId,
              sessionId: payload.sessionId,
              createdAt: new Date().toISOString(),
              data: {
                messageId: result.messageId,
                remoteJid: result.remoteJid,
                outboundId: payload.messageId,
              },
            },
          });
        } catch (postErr) {
          log.error(
            { err: postErr, sessionId: payload.sessionId, messageId: result.messageId },
            "post-send side effects failed (message already sent)",
          );
        }

        log.info(
          {
            sessionId: payload.sessionId,
            messageId: result.messageId,
            remoteJid: result.remoteJid,
            event: "message.sent",
          },
          "outbound message metadata",
        );
        return { messageId: result.messageId, remoteJid: result.remoteJid };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (PRE_SEND_RETRYABLE.has(message)) {
          await db
            .update(outboundMessages)
            .set({ status: "queued", updatedAt: new Date() })
            .where(
              and(
                eq(outboundMessages.id, payload.messageId),
                eq(outboundMessages.status, "sending"),
              ),
            );
          throw err;
        }
        await db
          .update(outboundMessages)
          .set({
            status: "failed",
            error: message,
            bodyText: null,
            updatedAt: new Date(),
          })
          .where(eq(outboundMessages.id, payload.messageId));
        await markRedacted(job, payload as unknown as Record<string, unknown>);
        throw err;
      }
    },
    {
      connection,
      concurrency: 5,
      removeOnComplete: { age: 60, count: 200 },
      removeOnFail: { age: 1, count: 50 },
    },
  );
}
