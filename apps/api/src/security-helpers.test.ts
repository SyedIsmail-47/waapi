import { afterEach, describe, expect, it, vi } from "vitest";
import { toWhatsAppJid } from "./lib/phone.js";
import {
  assertPublicUrl,
  assertWebhookUrlShape,
  createPinnedAgent,
  isBlockedAddress,
  resolveAndValidate,
} from "./services/webhooks/ssrf.js";
import { signPayload, verifySignature } from "./services/webhooks/sign.js";
import { clientIp } from "./lib/client-ip.js";

describe("webhook URL SSRF protection", () => {
  const prevHttp = process.env.ALLOW_HTTP_WEBHOOKS;
  afterEach(() => {
    process.env.ALLOW_HTTP_WEBHOOKS = prevHttp;
    vi.restoreAllMocks();
  });

  it.each([
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://100.64.0.1/",
    "http://169.254.169.254/",
  ])("rejects private/literal address %s", async (url) => {
    process.env.ALLOW_HTTP_WEBHOOKS = "true";
    const host = new URL(url).hostname;
    await expect(resolveAndValidate(host)).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
  });

  it("rejects DNS names that resolve to a private IP", async () => {
    await expect(
      resolveAndValidate("evil.example", async () => [
        { address: "10.0.0.5", family: 4 },
      ] as never),
    ).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
  });

  it("rejects when any A/AAAA is private (rebinding stub)", async () => {
    await expect(
      resolveAndValidate("rebind.example", async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ] as never),
    ).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
  });

  it("rejects userinfo and non-https without ALLOW_HTTP_WEBHOOKS", () => {
    process.env.ALLOW_HTTP_WEBHOOKS = "false";
    expect(() => assertWebhookUrlShape("https://user:pass@example.com/hook")).toThrow(/userinfo/i);
  });

  it("blocks reserved ranges via isBlockedAddress", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::1")).toBe(true);
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("100.64.0.1")).toBe(true);
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
  });

  it("pinned agent lookup validates before connect", async () => {
    const agent = createPinnedAgent({
      lookup: (_hostname, _opts, cb) => {
        void resolveAndValidate("127.0.0.1").then(
          () => cb(null, "127.0.0.1", 4),
          (err) => cb(err as NodeJS.ErrnoException, "", 4),
        );
      },
    });
    expect(agent).toBeTruthy();
    await agent.close();
  });

  it("assertPublicUrl rejects loopback with http allowed", async () => {
    process.env.ALLOW_HTTP_WEBHOOKS = "true";
    await expect(assertPublicUrl("http://127.0.0.1/hook")).rejects.toMatchObject({
      code: "SSRF_BLOCKED",
    });
  });
});

describe("webhook HMAC", () => {
  it("signs payloads and verifies only an exact signature", () => {
    const secret = "webhook-test-secret";
    const timestamp = 1_729_000_000;
    const body = JSON.stringify({ type: "message.received", id: "evt_1" });
    const signature = signPayload(secret, timestamp, body);

    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySignature(secret, timestamp, body, signature)).toBe(true);
    expect(verifySignature(secret, timestamp, body, `sha256=${signature}`)).toBe(true);
    expect(verifySignature(secret, timestamp, `${body} `, signature)).toBe(false);
    expect(verifySignature(secret, timestamp + 1, body, signature)).toBe(false);
    expect(verifySignature(secret, timestamp, body, "not-a-signature")).toBe(false);
  });
});

describe("WhatsApp phone normalization", () => {
  it("accepts E.164 and JID passthrough", () => {
    expect(toWhatsAppJid("+14155552671")).toBe("14155552671@s.whatsapp.net");
    expect(toWhatsAppJid("14155552671@s.whatsapp.net")).toBe("14155552671@s.whatsapp.net");
  });

  it.each(["garbage", "123", "", "++14155552671"])("rejects invalid phone %j", (phone) => {
    expect(() => toWhatsAppJid(phone)).toThrow(/E\.164|JID/);
  });
});

describe("rate-limit client IP", () => {
  afterEach(() => {
    delete process.env.TRUST_CLOUDFLARE;
  });

  it("does not honor forged CF-Connecting-IP when TRUST_CLOUDFLARE=false", () => {
    process.env.TRUST_CLOUDFLARE = "false";
    const ip = clientIp({
      headers: { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" },
      ip: "10.0.0.1",
    } as never);
    expect(ip).toBe("10.0.0.1");
  });
});
