import { config } from "../config.js";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function assertTurnstile(
  token: string | undefined,
  remoteIp?: string,
): Promise<void> {
  if (config.TURNSTILE_DISABLED) return;
  const secret = config.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) {
    throw Object.assign(new Error("Turnstile is not configured"), {
      statusCode: 503,
      code: "TURNSTILE_UNAVAILABLE",
    });
  }
  if (!token) {
    throw Object.assign(new Error("Turnstile token required"), {
      statusCode: 400,
      code: "TURNSTILE_REQUIRED",
    });
  }

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  if (remoteIp) body.set("remoteip", remoteIp);

  const res = await fetch(SITEVERIFY, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw Object.assign(new Error("Turnstile verification failed"), {
      statusCode: 502,
      code: "TURNSTILE_UNAVAILABLE",
    });
  }
  const data = (await res.json()) as { success?: boolean };
  if (!data.success) {
    throw Object.assign(new Error("Turnstile challenge failed"), {
      statusCode: 400,
      code: "TURNSTILE_FAILED",
    });
  }
}
