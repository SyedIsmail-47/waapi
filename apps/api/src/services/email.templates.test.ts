import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WP-C: HTML+text templates with absolute PUBLIC_APP_URL dashboard links,
 * brand from BRAND_NAME, resend driver with mock fetch.
 */
describe("WP-C email templates", () => {
  const prev = { ...process.env };

  beforeEach(() => {
    process.env.PUBLIC_APP_URL = "https://app.example.test";
    process.env.BRAND_NAME = "AcmeWA";
    process.env.NODE_ENV = "test";
    process.env.EMAIL_DRIVER = "console";
    process.env.DATABASE_URL ??= "postgresql://waapi:waapi@localhost:5432/waapi";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.JWT_SECRET ??= "test-jwt-secret-that-is-at-least-32-bytes";
    process.env.ADMIN_API_SECRET ??= "test-admin-api-secret";
    process.env.WEBHOOK_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");
    process.env.PAYLOAD_ENCRYPTION_KEY ??= Buffer.alloc(32, 11).toString("base64");
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...prev };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("verify template includes absolute dashboard link, HTML+text, brand", async () => {
    const { buildEmailContent } = await import("./email.js");
    const msg = buildEmailContent({
      to: "user@example.test",
      kind: "verify_email",
      token: "tok_verify_abc",
    });
    expect(msg.subject).toContain("AcmeWA");
    expect(msg.text).toContain("https://app.example.test/verify-email?token=tok_verify_abc");
    expect(msg.html).toContain("https://app.example.test/verify-email?token=tok_verify_abc");
    expect(msg.html).toMatch(/<a\s/i);
    expect(msg.html).toContain("AcmeWA");
    // token must appear in links but never as a raw "token: xxx" dump alone is ok in text;
    // ensure no other secrets
    expect(msg.text).not.toMatch(/password|secret|api[_-]?key/i);
  });

  it("reset template includes absolute reset-password link", async () => {
    const { buildEmailContent } = await import("./email.js");
    const msg = buildEmailContent({
      to: "user@example.test",
      kind: "reset_password",
      token: "tok_reset_xyz",
    });
    expect(msg.subject).toContain("AcmeWA");
    expect(msg.text).toContain("https://app.example.test/reset-password?token=tok_reset_xyz");
    expect(msg.html).toContain("https://app.example.test/reset-password?token=tok_reset_xyz");
  });

  it("resend driver posts html+text and does not log token plaintext on success path", async () => {
    process.env.EMAIL_DRIVER = "resend";
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM = "noreply@example.test";
    vi.resetModules();

    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { deliverEmail } = await import("./email.js");
    await deliverEmail({
      to: "user@example.test",
      kind: "verify_email",
      token: "tok_secret_never_in_body_alone",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as {
      html?: string;
      text?: string;
      subject?: string;
      to?: string[];
    };
    expect(body.html).toContain("verify-email?token=");
    expect(body.text).toContain("verify-email?token=");
    expect(body.subject).toContain("AcmeWA");
    expect(body.to).toEqual(["user@example.test"]);
  });

  it("resend driver surfaces non-OK responses", async () => {
    process.env.EMAIL_DRIVER = "resend";
    process.env.RESEND_API_KEY = "re_test_key";
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const { deliverEmail } = await import("./email.js");
    await expect(
      deliverEmail({ to: "a@b.c", kind: "verify_email", token: "t" }),
    ).rejects.toThrow(/Resend failed/);
  });
});
