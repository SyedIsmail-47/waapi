/**
 * Central brand name. Prefer `getBrandName()` so renaming is env-driven.
 * Never hardcode the product name in UI strings or file contents elsewhere.
 */
export const BRAND_NAME_ENV = "BRAND_NAME";

/** Safe for tests/docs when env may be unset; prefer getBrandName() at runtime. */
export const BRAND_NAME_FALLBACK = "waapi";

export function getBrandName(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[BRAND_NAME_ENV]?.trim();
  if (!value) {
    throw new Error(`${BRAND_NAME_ENV} is required`);
  }
  return value;
}

/** Token prefixes, HTTP header names, and user-agent derived from brand. */
export function getBrandTokens(brand: string = BRAND_NAME_FALLBACK) {
  const slug = brand.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const legacy = BRAND_NAME_FALLBACK;
  return {
    brand,
    slug,
    patPrefix: `${slug}_pat_`,
    sessionKeyPrefix: `${slug}_sk_`,
    /** Accept during rename transition */
    legacyPatPrefix: `${legacy}_pat_`,
    legacySessionKeyPrefix: `${legacy}_sk_`,
    headerEvent: `x-${slug}-event`,
    headerTimestamp: `x-${slug}-timestamp`,
    headerDeliveryId: `x-${slug}-delivery-id`,
    headerSignature: `x-${slug}-signature`,
    /** Also accepted when reading inbound (not used for outbound after rename) */
    legacyHeaderSignature: `x-${legacy}-signature`,
    userAgentWebhooks: `${slug}-webhooks/1.0`,
    userAgentApi: `${slug}-api/1.0`,
  };
}
