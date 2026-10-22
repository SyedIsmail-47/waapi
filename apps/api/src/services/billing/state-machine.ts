export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "expired"
  | "paused";

export type BillingEvent =
  | { type: "trial_started" }
  | { type: "trial_ended" }
  | { type: "payment_succeeded" }
  | { type: "payment_failed" }
  | { type: "grace_elapsed" }
  | { type: "canceled" }
  | { type: "period_ended" }
  | { type: "reactivated" }
  | { type: "paused" }
  | { type: "resumed" };

const ALLOWED: Record<SubscriptionStatus, Partial<Record<BillingEvent["type"], SubscriptionStatus>>> =
  {
    trialing: {
      trial_ended: "expired",
      payment_succeeded: "active",
      canceled: "canceled",
      paused: "paused",
    },
    active: {
      payment_succeeded: "active", // plan change / subscription.updated while active
      payment_failed: "past_due",
      canceled: "canceled",
      period_ended: "expired",
      paused: "paused",
    },
    past_due: {
      payment_succeeded: "active",
      grace_elapsed: "expired",
      canceled: "canceled",
      paused: "paused",
    },
    canceled: {
      period_ended: "expired",
      reactivated: "active",
      payment_succeeded: "active",
    },
    expired: {
      payment_succeeded: "active",
      reactivated: "active",
      trial_started: "trialing",
    },
    paused: {
      resumed: "active",
      payment_succeeded: "active",
      canceled: "canceled",
    },
  };

export function transition(
  current: SubscriptionStatus,
  event: BillingEvent,
): SubscriptionStatus {
  const next = ALLOWED[current]?.[event.type];
  if (!next) {
    throw Object.assign(new Error(`Invalid transition ${current} + ${event.type}`), {
      statusCode: 409,
      code: "BILLING_INVALID_TRANSITION",
    });
  }
  return next;
}

/** Access allowed for create/send when not expired. past_due still allowed during grace. */
export function canUseProduct(
  status: SubscriptionStatus,
  now: Date,
  graceUntil: Date | null,
): boolean {
  if (status === "expired" || status === "paused") return false;
  if (status === "past_due" && graceUntil && now > graceUntil) return false;
  if (status === "canceled") return true; // until period end handled by caller flipping to expired
  return status === "trialing" || status === "active" || status === "past_due";
}
