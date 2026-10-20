import type { FastifyRequest } from "fastify";
import { config } from "../config.js";
import { clientIp } from "./client-ip.js";

export type AuthRateBucket =
  | "login"
  | "register"
  | "refresh"
  | "forgot-password"
  | "reset-password"
  | "verify-email"
  | "resend-verification";

const LIMITS: Record<AuthRateBucket, () => number> = {
  login: () => config.RATE_LIMIT_LOGIN,
  register: () => config.RATE_LIMIT_REGISTER,
  refresh: () => config.RATE_LIMIT_REFRESH,
  "forgot-password": () => config.RATE_LIMIT_FORGOT_PASSWORD,
  "reset-password": () => config.RATE_LIMIT_RESET_PASSWORD,
  "verify-email": () => config.RATE_LIMIT_VERIFY_EMAIL,
  "resend-verification": () => config.RATE_LIMIT_RESEND_VERIFICATION,
};

/** Distinct Redis key per auth route so exhausting one bucket cannot starve another. */
export function authRateLimitKey(bucket: AuthRateBucket, request: FastifyRequest): string {
  return `auth:${bucket}:ip:${clientIp(request)}`;
}

export function authRateLimitConfig(bucket: AuthRateBucket) {
  return {
    config: {
      rateLimit: {
        max: LIMITS[bucket](),
        keyGenerator: (request: FastifyRequest) => authRateLimitKey(bucket, request),
      },
    },
  };
}
