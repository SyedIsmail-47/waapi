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
  rawHash: string;
};

export interface BillingProvider {
  readonly name: "manual" | "paddle";
  createCheckout(input: CheckoutInput): Promise<{ url: string | null }>;
  verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<VerifiedBillingEvent>;
}
