import { and, asc, eq, isNull, lt } from "drizzle-orm";
import {
  accounts,
  billingEvents,
  securityAuditLog,
  sessions,
  subscriptions,
  type Db,
} from "@waapi/db";
import { getPlan } from "@waapi/shared";
import { config } from "../../config.js";
import { sessionCommandsQueue, defaultJobOptions } from "../queues.js";
import { manualProvider } from "./manual-provider.js";
import { paddleProvider, planFromPriceId } from "./paddle-provider.js";
import { canUseProduct, transition, type SubscriptionStatus } from "./state-machine.js";
import type { BillingProvider, VerifiedBillingEvent } from "./provider.js";

const db = (value: Db) => value.db;

export function getBillingProvider(): BillingProvider {
  return config.BILLING_PROVIDER === "paddle" ? paddleProvider : manualProvider;
}

export async function ensureSubscription(database: Db, accountId: string) {
  const [existing] = await db(database)
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.accountId, accountId))
    .limit(1);
  if (existing) return existing;

  const trialDays = config.TRIAL_DAYS;
  const trialEndsAt =
    trialDays > 0 ? new Date(Date.now() + trialDays * 86_400_000) : null;
  const plan = getPlan("trial");
  const [row] = await db(database)
    .insert(subscriptions)
    .values({
      accountId,
      planCode: "trial",
      status: trialDays > 0 ? "trialing" : "expired",
      trialEndsAt,
      provider: config.BILLING_PROVIDER,
    })
    .returning();
  await db(database)
    .update(accounts)
    .set({ planCode: "trial", maxSessions: plan.maxSessions })
    .where(eq(accounts.id, accountId));
  return row!;
}

export async function getBillingSnapshot(database: Db, accountId: string) {
  const sub = await ensureSubscription(database, accountId);
  const plan = getPlan(sub.planCode);
  return {
    planCode: sub.planCode,
    planName: plan.name,
    status: sub.status,
    maxSessions: plan.maxSessions,
    sendsPerDay: plan.sendsPerDay,
    sendsPerMinute: plan.sendsPerMinute,
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
    graceUntil: sub.graceUntil?.toISOString() ?? null,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    provider: sub.provider,
    contactToUpgrade: plan.contactToUpgrade ?? config.BILLING_PROVIDER === "manual",
  };
}

export async function assertBillingAllowsUse(database: Db, accountId: string) {
  const sub = await ensureSubscription(database, accountId);
  if (
    sub.status === "trialing" &&
    sub.trialEndsAt &&
    sub.trialEndsAt.getTime() < Date.now()
  ) {
    await applyTransition(database, accountId, { type: "trial_ended" });
    throw Object.assign(new Error("Trial expired"), {
      statusCode: 402,
      code: "BILLING_EXPIRED",
    });
  }
  if (
    sub.status === "past_due" &&
    sub.graceUntil &&
    sub.graceUntil.getTime() < Date.now()
  ) {
    await applyTransition(database, accountId, { type: "grace_elapsed" });
    throw Object.assign(new Error("Subscription expired"), {
      statusCode: 402,
      code: "BILLING_EXPIRED",
    });
  }
  if (!canUseProduct(sub.status as SubscriptionStatus, new Date(), sub.graceUntil)) {
    throw Object.assign(new Error("Subscription expired"), {
      statusCode: 402,
      code: "BILLING_EXPIRED",
    });
  }
}

export async function applyTransition(
  database: Db,
  accountId: string,
  event: Parameters<typeof transition>[1],
  opts?: { planCode?: string },
) {
  const sub = await ensureSubscription(database, accountId);
  const next = transition(sub.status as SubscriptionStatus, event);
  const planCode = opts?.planCode ?? sub.planCode;
  const plan = getPlan(planCode);
  const graceUntil =
    next === "past_due"
      ? new Date(Date.now() + config.BILLING_GRACE_DAYS * 86_400_000)
      : null;
  await db(database)
    .update(subscriptions)
    .set({
      status: next,
      planCode,
      graceUntil,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.accountId, accountId));
  await db(database)
    .update(accounts)
    .set({ planCode, maxSessions: plan.maxSessions })
    .where(eq(accounts.id, accountId));
  if (next === "expired" || next === "past_due" || next === "paused") {
    await disconnectExtraSessions(database, accountId, next === "paused" ? 0 : plan.maxSessions);
  }
  return next;
}

export async function setPlanManual(
  database: Db,
  accountId: string,
  planCode: string,
  status: SubscriptionStatus = "active",
) {
  await ensureSubscription(database, accountId);
  const plan = getPlan(planCode);
  await db(database)
    .update(subscriptions)
    .set({
      planCode,
      status,
      graceUntil: null,
      provider: "manual",
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.accountId, accountId));
  await db(database)
    .update(accounts)
    .set({ planCode, maxSessions: plan.maxSessions })
    .where(eq(accounts.id, accountId));
}

async function disconnectExtraSessions(database: Db, accountId: string, maxSessions: number) {
  const rows = await db(database)
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.accountId, accountId), isNull(sessions.deletedAt)))
    .orderBy(asc(sessions.createdAt));
  const extras = rows.slice(maxSessions);
  for (const row of extras) {
    await sessionCommandsQueue.add(
      "close-session",
      { type: "close-session", accountId, sessionId: row.id, requestId: `billing-cap-${row.id}` },
      { ...defaultJobOptions, jobId: `billing-disc-${row.id}-${Date.now()}` },
    );
  }
}

async function flagManualReview(database: Db, accountId: string, reason: string) {
  await db(database)
    .update(accounts)
    .set({ manualReviewAt: new Date(), manualReviewReason: reason.slice(0, 200) })
    .where(eq(accounts.id, accountId));
  await db(database).insert(securityAuditLog).values({
    accountId,
    eventType: "billing.manual_review",
    meta: { reason: reason.slice(0, 200) },
  });
}

/** Sweep trials / past_due past grace → expired and disconnect extras. */
export async function sweepBillingExpirations(database: Db): Promise<number> {
  const now = new Date();
  const trialRows = await db(database)
    .select({ accountId: subscriptions.accountId })
    .from(subscriptions)
    .where(
      and(eq(subscriptions.status, "trialing"), lt(subscriptions.trialEndsAt, now)),
    );
  const graceRows = await db(database)
    .select({ accountId: subscriptions.accountId })
    .from(subscriptions)
    .where(
      and(eq(subscriptions.status, "past_due"), lt(subscriptions.graceUntil, now)),
    );
  let n = 0;
  for (const row of [...trialRows, ...graceRows]) {
    try {
      const sub = await ensureSubscription(database, row.accountId);
      if (sub.status === "trialing") {
        await applyTransition(database, row.accountId, { type: "trial_ended" });
      } else if (sub.status === "past_due") {
        await applyTransition(database, row.accountId, { type: "grace_elapsed" });
      }
      n += 1;
    } catch {
      /* invalid transition race — ignore */
    }
  }
  return n;
}

/**
 * Idempotent webhook processing — duplicate event_id is a no-op success.
 * N2: account only trusted after signature (caller); customer id bound on first
 * event; later custom_data account must match the bound customer.
 */
export async function processBillingEvent(
  database: Db,
  event: VerifiedBillingEvent,
): Promise<{ duplicate: boolean; ignored?: boolean }> {
  try {
    await db(database).insert(billingEvents).values({
      provider: event.provider,
      eventId: event.eventId,
      eventType: event.eventType,
      payloadHash: event.rawHash,
      accountId: event.accountId,
    });
  } catch (err) {
    const codes: string[] = [];
    let cur: unknown = err;
    for (let i = 0; i < 4 && cur && typeof cur === "object"; i++) {
      if ("code" in cur && typeof (cur as { code?: unknown }).code === "string") {
        codes.push((cur as { code: string }).code);
      }
      cur = "cause" in cur ? (cur as { cause?: unknown }).cause : undefined;
    }
    if (codes.includes("23505")) return { duplicate: true };
    throw err;
  }

  if (!event.accountId) return { duplicate: false, ignored: true };

  // N2: unknown price (when present) → ignore + audit
  if (event.priceId && !planFromPriceId(event.priceId)) {
    await db(database).insert(securityAuditLog).values({
      accountId: event.accountId,
      eventType: "billing.unknown_price",
      meta: { priceId: event.priceId, eventType: event.eventType },
    });
    return { duplicate: false, ignored: true };
  }

  // N2: bind provider customer id; ignore events whose custom_data account ≠ bound account
  if (event.customerId) {
    const [bound] = await db(database)
      .select({
        accountId: subscriptions.accountId,
        providerCustomerId: subscriptions.providerCustomerId,
      })
      .from(subscriptions)
      .where(eq(subscriptions.providerCustomerId, event.customerId))
      .limit(1);

    if (bound) {
      if (bound.accountId !== event.accountId) {
        await db(database).insert(securityAuditLog).values({
          accountId: event.accountId,
          eventType: "billing.account_mismatch",
          meta: { boundAccountId: bound.accountId, customerId: event.customerId },
        });
        return { duplicate: false, ignored: true };
      }
    } else {
      await db(database)
        .update(subscriptions)
        .set({ providerCustomerId: event.customerId, updatedAt: new Date() })
        .where(eq(subscriptions.accountId, event.accountId));
    }
  }

  const type = event.eventType.toLowerCase();
  const planCode = event.planCode;

  // N3: refunds / chargebacks AND subscription.updated|paused|resumed → manual review
  // only (no auto-suspend, no auto plan/status change). These are ambiguous or
  // risk-bearing webhook-driven transitions; a human decides, the account keeps
  // using the product in the meantime.
  if (
    type.startsWith("adjustment.") ||
    type.includes("refund") ||
    type.includes("chargeback") ||
    type.includes("subscription.updated") ||
    type.includes("subscription.paused") ||
    type.includes("subscription.resumed")
  ) {
    await flagManualReview(database, event.accountId, event.eventType);
    return { duplicate: false };
  }

  if (
    type.includes("transaction.completed") ||
    type.includes("subscription.activated")
  ) {
    await applyTransition(database, event.accountId, { type: "payment_succeeded" }, {
      planCode,
    });
  } else if (
    type.includes("payment_failed") ||
    type.includes("subscription.past_due") ||
    type.includes("transaction.payment_failed")
  ) {
    await applyTransition(database, event.accountId, { type: "payment_failed" });
  } else if (
    type.includes("subscription.canceled") ||
    type.includes("subscription.cancelled")
  ) {
    await applyTransition(database, event.accountId, { type: "canceled" });
  }
  // else: ignored after idempotent ledger insert

  return { duplicate: false };
}
