import type { BillingProvider, CheckoutInput, VerifiedBillingEvent } from "./provider.js";

/** Ops-driven billing — no checkout URL; dashboard shows contact support. */
export const manualProvider: BillingProvider = {
  name: "manual",
  async createCheckout(_input: CheckoutInput) {
    return { url: null };
  },
  async verifyWebhook(): Promise<VerifiedBillingEvent> {
    throw Object.assign(new Error("Manual provider has no webhooks"), {
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
  },
};
