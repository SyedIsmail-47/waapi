import { describe, expect, it } from "vitest";
import { canUseProduct, transition, type SubscriptionStatus } from "./state-machine.js";

describe("WP-F billing state machine", () => {
  const cases: Array<{
    from: SubscriptionStatus;
    event: Parameters<typeof transition>[1];
    to: SubscriptionStatus;
  }> = [
    { from: "trialing", event: { type: "payment_succeeded" }, to: "active" },
    { from: "trialing", event: { type: "trial_ended" }, to: "expired" },
    { from: "trialing", event: { type: "canceled" }, to: "canceled" },
    { from: "active", event: { type: "payment_failed" }, to: "past_due" },
    { from: "active", event: { type: "canceled" }, to: "canceled" },
    { from: "active", event: { type: "period_ended" }, to: "expired" },
    { from: "past_due", event: { type: "payment_succeeded" }, to: "active" },
    { from: "past_due", event: { type: "grace_elapsed" }, to: "expired" },
    { from: "canceled", event: { type: "period_ended" }, to: "expired" },
    { from: "canceled", event: { type: "reactivated" }, to: "active" },
    { from: "expired", event: { type: "payment_succeeded" }, to: "active" },
    { from: "expired", event: { type: "trial_started" }, to: "trialing" },
  ];

  it.each(cases)("$from + $event.type → $to", ({ from, event, to }) => {
    expect(transition(from, event)).toBe(to);
  });

  it("rejects illegal transitions", () => {
    expect(() => transition("active", { type: "trial_started" })).toThrow(/Invalid transition/);
    expect(() => transition("expired", { type: "payment_failed" })).toThrow(/Invalid transition/);
  });

  it("canUseProduct respects expired and grace", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    expect(canUseProduct("active", now, null)).toBe(true);
    expect(canUseProduct("trialing", now, null)).toBe(true);
    expect(canUseProduct("expired", now, null)).toBe(false);
    expect(canUseProduct("past_due", now, new Date("2026-01-12T00:00:00Z"))).toBe(true);
    expect(canUseProduct("past_due", now, new Date("2026-01-09T00:00:00Z"))).toBe(false);
  });
});
