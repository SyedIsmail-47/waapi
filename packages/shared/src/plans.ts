export type PlanCode = "trial" | "starter" | "pro" | "enterprise";

export type PlanDefinition = {
  code: PlanCode;
  name: string;
  maxSessions: number;
  sendsPerDay: number;
  /** TODO(owner): conservative placeholder — override via env SEND_LIMIT_* */
  sendsPerMinute: number;
  /** Public pricing blurb; empty for trial/enterprise contact. */
  priceLabel: string;
  contactToUpgrade?: boolean;
};

export const PLANS: Record<PlanCode, PlanDefinition> = {
  trial: {
    code: "trial",
    name: "Trial",
    maxSessions: 1,
    sendsPerDay: 50,
    sendsPerMinute: 5,
    priceLabel: "Free trial",
  },
  starter: {
    code: "starter",
    name: "Starter",
    maxSessions: 1,
    sendsPerDay: 500,
    sendsPerMinute: 20,
    priceLabel: "Contact support",
    contactToUpgrade: true,
  },
  pro: {
    code: "pro",
    name: "Pro",
    maxSessions: 5,
    sendsPerDay: 5000,
    sendsPerMinute: 60,
    priceLabel: "Contact support",
    contactToUpgrade: true,
  },
  enterprise: {
    code: "enterprise",
    name: "Enterprise",
    maxSessions: 50,
    sendsPerDay: 50_000,
    sendsPerMinute: 120,
    priceLabel: "Contact support",
    contactToUpgrade: true,
  },
};

/** Sessions younger than this use a stricter warm-up send cap. TODO(owner) tune. */
export const SEND_WARMUP_DAYS = 7;
export const SEND_WARMUP_PER_DAY = 30;
export const SEND_WARMUP_PER_MINUTE = 3;

export const PUBLIC_PLAN_CODES: PlanCode[] = ["starter", "pro", "enterprise"];

export function getPlan(code: string): PlanDefinition {
  const plan = PLANS[code as PlanCode];
  if (!plan) return PLANS.trial;
  return plan;
}
