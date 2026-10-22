export type PlanCode = "trial" | "starter" | "pro" | "enterprise";

export type PlanDefinition = {
  code: PlanCode;
  name: string;
  maxSessions: number;
  sendsPerDay: number;
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
    priceLabel: "Free trial",
  },
  starter: {
    code: "starter",
    name: "Starter",
    maxSessions: 1,
    sendsPerDay: 500,
    priceLabel: "Contact support",
    contactToUpgrade: true,
  },
  pro: {
    code: "pro",
    name: "Pro",
    maxSessions: 5,
    sendsPerDay: 5000,
    priceLabel: "Contact support",
    contactToUpgrade: true,
  },
  enterprise: {
    code: "enterprise",
    name: "Enterprise",
    maxSessions: 50,
    sendsPerDay: 50_000,
    priceLabel: "Contact support",
    contactToUpgrade: true,
  },
};

export const PUBLIC_PLAN_CODES: PlanCode[] = ["starter", "pro", "enterprise"];

export function getPlan(code: string): PlanDefinition {
  const plan = PLANS[code as PlanCode];
  if (!plan) return PLANS.trial;
  return plan;
}
