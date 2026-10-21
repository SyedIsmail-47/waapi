import type { FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export const REFRESH_COOKIE = "waapi_rt";
export const CSRF_COOKIE = "waapi_csrf";
export const CSRF_HEADER = "x-csrf-token";

const REFRESH_PATH = "/api/v1/auth";

function cookieSecure(): boolean {
  if (config.NODE_ENV === "test") return false;
  return config.COOKIE_SECURE;
}

function refreshMaxAgeSeconds(): number {
  const match = /^(\d+)([mhd])$/.exec(config.REFRESH_TTL);
  if (!match) return 30 * 86_400;
  const n = Number(match[1]);
  const unit = { m: 60, h: 3600, d: 86_400 }[match[2]!]!;
  return n * unit;
}

export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function setAuthCookies(
  reply: FastifyReply,
  refreshToken: string,
  csrfToken = newCsrfToken(),
): void {
  const secure = cookieSecure();
  const maxAge = refreshMaxAgeSeconds();
  reply.setCookie(REFRESH_COOKIE, refreshToken, {
    path: REFRESH_PATH,
    httpOnly: true,
    secure,
    sameSite: "strict",
    maxAge,
  });
  reply.setCookie(CSRF_COOKIE, csrfToken, {
    path: "/",
    httpOnly: false,
    secure,
    sameSite: "strict",
    maxAge,
  });
}

export function clearAuthCookies(reply: FastifyReply): void {
  const secure = cookieSecure();
  reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH, secure, sameSite: "strict" });
  reply.clearCookie(CSRF_COOKIE, { path: "/", secure, sameSite: "strict" });
}

export function readRefreshFromRequest(request: FastifyRequest): string | undefined {
  const fromCookie = request.cookies?.[REFRESH_COOKIE];
  if (typeof fromCookie === "string" && fromCookie.length >= 20) return fromCookie;
  const body = request.body as { refreshToken?: unknown } | null;
  if (body && typeof body.refreshToken === "string" && body.refreshToken.length >= 20) {
    return body.refreshToken;
  }
  return undefined;
}

export function usedCookieRefresh(request: FastifyRequest): boolean {
  const fromCookie = request.cookies?.[REFRESH_COOKIE];
  return typeof fromCookie === "string" && fromCookie.length >= 20;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Require CSRF double-submit when the refresh cookie is present (browser mode). */
export function assertCsrfForCookieMode(request: FastifyRequest): void {
  if (!usedCookieRefresh(request)) return;
  const cookie = request.cookies?.[CSRF_COOKIE];
  const header = request.headers[CSRF_HEADER];
  const headerVal = Array.isArray(header) ? header[0] : header;
  if (
    typeof cookie !== "string" ||
    typeof headerVal !== "string" ||
    cookie.length < 16 ||
    !safeEqual(cookie, headerVal)
  ) {
    throw Object.assign(new Error("CSRF token missing or invalid"), {
      statusCode: 403,
      code: "CSRF_INVALID",
    });
  }
}
