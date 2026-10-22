export type CheckoutInput = {
  accountId: string;
  planCode: string;
  successUrl: string;
  cancelUrl: string;
};

export type VerifiedBillingEvent = {
  provider: string;
  eventId: string;
  eventType: string;
  accountId?: string;
  planCode?: string;
  priceId?: string;
  customerId?: string;
  rawHash: string;
  /** Flag account for admin manual review (refunds/chargebacks). */
  manualReview?: boolean;
  manualReviewReason?: string;
};

export interface BillingProvider {
  readonly name: "manual" | "paddle";
  createCheckout(input: CheckoutInput): Promise<{ url: string | null }>;
  /**
   * Verify webhook over exact raw body string (UTF-8 of Buffer) — never re-stringify.
   */
  verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<VerifiedBillingEvent>;
}
