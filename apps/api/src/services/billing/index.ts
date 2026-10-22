import { and, asc, eq, isNull } from "drizzle-orm";
import {
  accounts,
  billingEvents,
  sessions,
  subscriptions,
  type Db,
} from "@waapi/db";
import { getPlan } from "@waapi/shared";
import { config } from "../../config.js";
import { sessionCommandsQueue, defaultJobOptions } from "../queues.js";
import { manualProvider } from "./manual-provider.js";
import { paddleProvider } from "./paddle-provider.js";
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
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
    graceUntil: sub.graceUntil?.toISOString() ?? null,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    provider: sub.provider,
    contactToUpgrade: plan.contactToUpgrade ?? config.BILLING_PROVIDER === "manual",
  };
}

export async function assertBillingAllowsUse(database: Db, accountId: string) {
  const sub = await ensureSubscription(database, accountId);
  // Expire trials that passed trialEndsAt
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
  if (next === "expired" || next === "past_due") {
    await disconnectExtraSessions(database, accountId, plan.maxSessions);
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

/** Idempotent webhook processing — duplicate event_id is a no-op success. */
export async function processBillingEvent(
  database: Db,
  event: VerifiedBillingEvent,
): Promise<{ duplicate: boolean }> {
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

  if (!event.accountId) return { duplicate: false };

  const type = event.eventType.toLowerCase();
  if (type.includes("transaction.completed") || type.includes("subscription.activated")) {
    await applyTransition(database, event.accountId, { type: "payment_succeeded" }, {
      planCode: event.planCode,
    });
  } else if (type.includes("payment_failed") || type.includes("subscription.past_due")) {
    await applyTransition(database, event.accountId, { type: "payment_failed" });
  } else if (type.includes("subscription.canceled")) {
    await applyTransition(database, event.accountId, { type: "canceled" });
  }
  return { duplicate: false };
}
