import { afterEach, describe, expect, it } from "vitest";
import { clientIp } from "./client-ip.js";
import { authRateLimitKey } from "./auth-rate-limit.js";

function req(ip: string, headers: Record<string, string> = {}) {
  return { ip, headers } as never;
}

describe("clientIp", () => {
  afterEach(() => {
    delete process.env.TRUST_CLOUDFLARE;
  });

  it("ignores forged CF-Connecting-IP and X-Forwarded-For when TRUST_CLOUDFLARE=false", () => {
    process.env.TRUST_CLOUDFLARE = "false";
    const ip = clientIp(
      req("10.0.0.5", {
        "cf-connecting-ip": "203.0.113.9",
        "x-forwarded-for": "198.51.100.1",
      }),
    );
    expect(ip).toBe("10.0.0.5");
  });

  it("uses CF-Connecting-IP only when TRUST_CLOUDFLARE=true", () => {
    process.env.TRUST_CLOUDFLARE = "true";
    expect(clientIp(req("10.0.0.5", { "cf-connecting-ip": "203.0.113.9" }))).toBe(
      "203.0.113.9",
    );
  });
});

describe("auth rate-limit buckets", () => {
  it("uses distinct keys per route so exhausting one does not affect another", () => {
    process.env.TRUST_CLOUDFLARE = "false";
    const request = req("203.0.113.10");
    const loginKey = authRateLimitKey("login", request);
    const registerKey = authRateLimitKey("register", request);
    expect(loginKey).not.toBe(registerKey);
    expect(loginKey).toContain("auth:login:");
    expect(registerKey).toContain("auth:register:");
    expect(loginKey).toContain("203.0.113.10");
  });
});
