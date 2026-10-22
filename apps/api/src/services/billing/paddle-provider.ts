import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";
import { sha256 } from "../../lib/crypto.js";
import type { BillingProvider, CheckoutInput, VerifiedBillingEvent } from "./provider.js";

function paddleSecret(): string {
  const secret = (process.env.PADDLE_WEBHOOK_SECRET ?? config.PADDLE_WEBHOOK_SECRET ?? "").trim();
  if (!secret) {
    throw Object.assign(new Error("PADDLE_WEBHOOK_SECRET not configured"), {
      statusCode: 503,
      code: "NOT_READY",
    });
  }
  return secret;
}

/**
 * Paddle Billing sandbox adapter (server-created checkout + verified webhooks).
 * Card data never touches our servers.
 */
export const paddleProvider: BillingProvider = {
  name: "paddle",
  async createCheckout(input: CheckoutInput) {
    const apiKey = config.PADDLE_API_KEY?.trim();
    if (!apiKey) {
      throw Object.assign(new Error("PADDLE_API_KEY not configured"), {
        statusCode: 503,
        code: "NOT_READY",
      });
    }
    const priceId = config.PADDLE_PRICE_IDS?.[input.planCode];
    if (!priceId) {
      throw Object.assign(new Error(`No Paddle price for plan ${input.planCode}`), {
        statusCode: 400,
        code: "VALIDATION_ERROR",
      });
    }
    const base =
      config.PADDLE_ENV === "production"
        ? "https://api.paddle.com"
        : "https://sandbox-api.paddle.com";
    const res = await fetch(`${base}/transactions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        custom_data: { accountId: input.accountId, planCode: input.planCode },
        checkout: {
          url: input.successUrl,
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Paddle checkout failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      data?: { checkout?: { url?: string }; id?: string };
    };
    const url = json.data?.checkout?.url ?? null;
    return { url };
  },

  async verifyWebhook(headers, rawBody): Promise<VerifiedBillingEvent> {
    const signature = headers["paddle-signature"];
    const sig = Array.isArray(signature) ? signature[0] : signature;
    if (!sig) {
      throw Object.assign(new Error("Missing Paddle signature"), {
        statusCode: 401,
        code: "UNAUTHORIZED",
      });
    }
    // Paddle sends ts=...;h1=... — verify h1 HMAC of `${ts}:${rawBody}`.
    const parts = Object.fromEntries(
      sig.split(";").map((p) => {
        const [k, v] = p.split("=");
        return [k?.trim() ?? "", v?.trim() ?? ""];
      }),
    );
    const ts = parts["ts"];
    const h1 = parts["h1"];
    if (!ts || !h1) {
      throw Object.assign(new Error("Invalid Paddle signature format"), {
        statusCode: 401,
        code: "UNAUTHORIZED",
      });
    }
    const tsNum = Number(ts);
    const skewMs = 5 * 60_000;
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum * 1000) > skewMs) {
      throw Object.assign(new Error("Stale Paddle webhook timestamp"), {
        statusCode: 401,
        code: "UNAUTHORIZED",
      });
    }
    const expected = createHmac("sha256", paddleSecret())
      .update(`${ts}:${rawBody}`)
      .digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(h1);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw Object.assign(new Error("Invalid Paddle signature"), {
        statusCode: 401,
        code: "UNAUTHORIZED",
      });
    }
    const payload = JSON.parse(rawBody) as {
      event_id?: string;
      event_type?: string;
      data?: {
        custom_data?: { accountId?: string; planCode?: string };
        id?: string;
      };
    };
    const eventId = payload.event_id ?? payload.data?.id;
    if (!eventId || !payload.event_type) {
      throw Object.assign(new Error("Malformed Paddle event"), {
        statusCode: 400,
        code: "VALIDATION_ERROR",
      });
    }
    return {
      provider: "paddle",
      eventId,
      eventType: payload.event_type,
      accountId: payload.data?.custom_data?.accountId,
      planCode: payload.data?.custom_data?.planCode,
      rawHash: sha256(rawBody),
    };
  },
};
