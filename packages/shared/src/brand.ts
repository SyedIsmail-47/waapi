/**
 * Central brand name. Prefer `getBrandName()` so renaming is env-driven.
 * Never hardcode the product name in UI strings or file contents elsewhere.
 */
export const BRAND_NAME_ENV = "BRAND_NAME";

export function getBrandName(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[BRAND_NAME_ENV]?.trim();
  if (!value) {
    throw new Error(`${BRAND_NAME_ENV} is required`);
  }
  return value;
}

/** Safe for tests/docs when env may be unset; prefer getBrandName() at runtime. */
export const BRAND_NAME_FALLBACK = "waapi";
