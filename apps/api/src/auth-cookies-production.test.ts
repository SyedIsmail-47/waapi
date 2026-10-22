import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply } from "fastify";
import {
  CSRF_COOKIE,
  REFRESH_COOKIE,
  clearAuthCookies,
  setAuthCookies,
} from "./lib/auth-cookies.js";

/**
 * N5: with NODE_ENV=production assert refresh cookie HttpOnly; Secure;
 * SameSite=Strict; Path=/api/v1/auth; no Domain; CSRF flags; logout clears both.
 */
describe("N5 production auth cookies", () => {
  const prev = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = prev;
    vi.restoreAllMocks();
  });

  function mockReply() {
    const cookies: Array<{ name: string; value: string; opts: Record<string, unknown> }> = [];
    const cleared: Array<{ name: string; opts: Record<string, unknown> }> = [];
    const reply = {
      setCookie(name: string, value: string, opts: Record<string, unknown>) {
        cookies.push({ name, value, opts });
        return reply;
      },
      clearCookie(name: string, opts: Record<string, unknown>) {
        cleared.push({ name, opts });
        return reply;
      },
    } as unknown as FastifyReply;
    return { reply, cookies, cleared };
  }

  it("sets Secure HttpOnly Strict Path=/api/v1/auth with no Domain", () => {
    process.env.NODE_ENV = "production";
    const { reply, cookies } = mockReply();
    setAuthCookies(reply, "refresh-token-value-at-least-20chars");

    const refresh = cookies.find((c) => c.name === REFRESH_COOKIE);
    expect(refresh).toBeTruthy();
    expect(refresh!.opts.httpOnly).toBe(true);
    expect(refresh!.opts.secure).toBe(true);
    expect(refresh!.opts.sameSite).toBe("strict");
    expect(refresh!.opts.path).toBe("/api/v1/auth");
    expect(refresh!.opts.domain).toBeUndefined();

    const csrf = cookies.find((c) => c.name === CSRF_COOKIE);
    expect(csrf).toBeTruthy();
    expect(csrf!.opts.httpOnly).toBe(false);
    expect(csrf!.opts.secure).toBe(true);
    expect(csrf!.opts.sameSite).toBe("strict");
    expect(csrf!.opts.path).toBe("/");
    expect(csrf!.opts.domain).toBeUndefined();
  });

  it("logout clears both cookies with matching Path/Secure/SameSite", () => {
    process.env.NODE_ENV = "production";
    const { reply, cleared } = mockReply();
    clearAuthCookies(reply);
    expect(cleared.map((c) => c.name).sort()).toEqual([CSRF_COOKIE, REFRESH_COOKIE].sort());
    const refresh = cleared.find((c) => c.name === REFRESH_COOKIE)!;
    expect(refresh.opts.path).toBe("/api/v1/auth");
    expect(refresh.opts.secure).toBe(true);
    expect(refresh.opts.sameSite).toBe("strict");
    const csrf = cleared.find((c) => c.name === CSRF_COOKIE)!;
    expect(csrf.opts.path).toBe("/");
    expect(csrf.opts.secure).toBe(true);
  });
});
