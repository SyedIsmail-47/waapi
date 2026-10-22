import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { idempotencyKeys, outboundMessages, sessions, type Db } from "@waapi/db";
import { toWhatsAppJid } from "../lib/phone.js";
import { defaultJobOptions, sendTextQueue } from "./queues.js";

type SendInput = { sessionId: string; to: string; text: string };
type SendResponse = { id: string; status: "queued" | "failed" | "in_progress" };

const POLL_MS = 25;
const POLL_MAX_MS = 5_000;

async function waitForIdempotencyResponse(
  database: Db,
  accountId: string,
  key: string,
  bodyHash: string,
): Promise<SendResponse> {
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    const [row] = await database.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key)))
      .limit(1);
    if (!row) {
      throw Object.assign(new Error("Idempotency claim failed"), {
        statusCode: 500,
        code: "INTERNAL_ERROR",
      });
    }
    if (row.requestHash !== bodyHash) {
      throw Object.assign(new Error("Idempotency key reused with different body"), {
        statusCode: 409,
        code: "IDEMPOTENCY_CONFLICT",
      });
    }
    const body = row.responseBody as { id?: string | null; status?: string };
    if (body.status === "failed") {
      return { id: body.id ?? "", status: "failed" };
    }
    if (body.id) {
      return { id: body.id, status: (body.status as "queued") ?? "queued" };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw Object.assign(new Error("Idempotent request still in progress"), {
    statusCode: 409,
    code: "IDEMPOTENCY_IN_PROGRESS",
  });
}

export async function sendText(
  database: Db,
  accountId: string,
  input: SendInput,
  key: string,
  requestId: string,
): Promise<SendResponse> {
  const { assertBillingAllowsUse } = await import("./billing/index.js");
  await assertBillingAllowsUse(database, accountId);

  const bodyHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const claimId = randomUUID();

  // INSERT ... RETURNING decides the winner; losers get no row.
  const inserted = await database.db.execute(sql`
    insert into idempotency_keys (id, account_id, key, request_hash, response_status, response_body, expires_at)
    values (
      ${claimId}::uuid,
      ${accountId}::uuid,
      ${key},
      ${bodyHash},
      202,
      ${JSON.stringify({ id: null, status: "queued" })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz
    )
    on conflict (account_id, key) do nothing
    returning id
  `);

  const won = Boolean(inserted[0]);
  if (!won) {
    return waitForIdempotencyResponse(database, accountId, key, bodyHash);
  }

  const [session] = await database.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, input.sessionId), eq(sessions.accountId, accountId)))
    .limit(1);
  if (!session || session.deletedAt) {
    await database.db
      .update(idempotencyKeys)
      .set({
        responseStatus: 404,
        responseBody: { id: null, status: "failed", error: "NOT_FOUND" },
      })
      .where(eq(idempotencyKeys.id, claimId));
    throw Object.assign(new Error("Session not found"), { statusCode: 404, code: "NOT_FOUND" });
  }
  if (session.status !== "connected") {
    await database.db
      .update(idempotencyKeys)
      .set({
        responseStatus: 409,
        responseBody: { id: null, status: "failed", error: "SESSION_NOT_CONNECTED" },
      })
      .where(eq(idempotencyKeys.id, claimId));
    throw Object.assign(new Error("Session is not connected"), {
      statusCode: 409,
      code: "SESSION_NOT_CONNECTED",
    });
  }

  const to = toWhatsAppJid(input.to);
  let messageId: string;
  try {
    const [row] = await database.db
      .insert(outboundMessages)
      .values({
        accountId,
        sessionId: input.sessionId,
        toJid: to,
        idempotencyKey: key,
        bodyText: input.text,
      })
      .returning();
    messageId = row!.id;
  } catch (err) {
    // Unique violation: another winner path — wait for their response.
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique|duplicate/i.test(msg)) {
      return waitForIdempotencyResponse(database, accountId, key, bodyHash);
    }
    await database.db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, claimId));
    throw err;
  }

  const response: SendResponse = { id: messageId, status: "queued" };
  await database.db
    .update(idempotencyKeys)
    .set({ responseStatus: 202, responseBody: response })
    .where(eq(idempotencyKeys.id, claimId));

  try {
    await sendTextQueue.add(
      "send-text",
      {
        accountId,
        sessionId: input.sessionId,
        to,
        text: input.text,
        messageId,
        idempotencyKey: key,
        requestId,
        redacted: false,
      },
      {
        ...defaultJobOptions,
        jobId: messageId,
        attempts: 5,
        backoff: { type: "exponential", delay: 1_000 },
      },
    );
  } catch (err) {
    // Drop claim + outbound so the same key can retry cleanly.
    await database.db.delete(outboundMessages).where(eq(outboundMessages.id, messageId));
    await database.db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, claimId));
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      statusCode: 503,
      code: "INTERNAL_ERROR",
    });
  }

  return response;
}

/** Re-enqueue outbound rows stuck in queued for > 60s (missed jobs). */
export async function sweepStaleOutbound(database: Db): Promise<number> {
  const stale = await database.db.execute(sql`
    select id, account_id, session_id, to_jid, idempotency_key, body_text
    from outbound_messages
    where status = 'queued'
      and body_text is not null
      and updated_at < now() - interval '60 seconds'
    limit 100
  `);
  let n = 0;
  for (const row of stale as unknown as Array<{
    id: string;
    account_id: string;
    session_id: string;
    to_jid: string;
    idempotency_key: string | null;
    body_text: string;
  }>) {
    try {
      await sendTextQueue.add(
        "send-text",
        {
          accountId: row.account_id,
          sessionId: row.session_id,
          to: row.to_jid,
          text: row.body_text,
          messageId: row.id,
          idempotencyKey: row.idempotency_key ?? undefined,
          requestId: `sweep-${row.id}`,
          redacted: false,
          sweep: true,
        },
        { ...defaultJobOptions, jobId: `sweep-${row.id}-${Date.now()}`, attempts: 3 },
      );
      n += 1;
    } catch {
      /* ignore single failure */
    }
  }
  return n;
}
