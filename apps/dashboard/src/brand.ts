import { BRAND_NAME_FALLBACK } from "@waapi/shared";

/** Single brand constant for all dashboard UI copy. */
export const BRAND_NAME =
  (import.meta.env.VITE_BRAND_NAME?.trim() || BRAND_NAME_FALLBACK) as string;
