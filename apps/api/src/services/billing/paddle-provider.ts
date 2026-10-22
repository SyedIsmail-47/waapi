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

/** Server-side allowlist: Paddle price id → plan code (from PADDLE_PRICE_IDS). */
export function planFromPriceId(priceId: string | undefined): string | undefined {
  if (!priceId) return undefined;
  const map = config.PADDLE_PRICE_IDS ?? {};
  for (const [plan, id] of Object.entries(map)) {
    if (id === priceId) return plan;
  }
  return undefined;
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * Paddle Billing adapter — server-created checkout + raw-body verified webhooks.
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
      throw Object.assign(new Error("Unauthorized"), {
        statusCode: 401,
        code: "UNAUTHORIZED",
      });
    }
    // Paddle: ts=...;h1=...;h1=... (multiple h1 during secret rotation)
    const tsMatch = /(?:^|;)\s*ts=([^;]+)/.exec(sig);
    const h1Values = [...sig.matchAll(/(?:^|;)\s*h1=([a-f0-9]+)/gi)].map((m) => m[1]!);
    const ts = tsMatch?.[1]?.trim();
    if (!ts || h1Values.length === 0) {
      throw Object.assign(new Error("Unauthorized"), {
        statusCode: 401,
        code: "UNAUTHORIZED",
      });
    }
    const tsNum = Number(ts);
    const skewMs = 5 * 60_000;
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum * 1000) > skewMs) {
      throw Object.assign(new Error("Unauthorized"), {
        statusCode: 401,
        code: "UNAUTHORIZED",
      });
    }
    const expected = createHmac("sha256", paddleSecret())
      .update(`${ts}:${rawBody}`)
      .digest("hex");
    const ok = h1Values.some((h1) => safeEqualHex(expected, h1));
    if (!ok) {
      throw Object.assign(new Error("Unauthorized"), {
        statusCode: 401,
        code: "UNAUTHORIZED",
      });
    }

    let payload: {
      event_id?: string;
      event_type?: string;
      data?: {
        custom_data?: { accountId?: string; planCode?: string };
        id?: string;
        customer_id?: string;
        items?: Array<{ price?: { id?: string }; price_id?: string }>;
      };
    };
    try {
      payload = JSON.parse(rawBody) as typeof payload;
    } catch {
      throw Object.assign(new Error("Unauthorized"), {
        statusCode: 401,
        code: "UNAUTHORIZED",
      });
    }
    const eventId = payload.event_id ?? payload.data?.id;
    if (!eventId || !payload.event_type) {
      throw Object.assign(new Error("Unauthorized"), {
        statusCode: 401,
        code: "UNAUTHORIZED",
      });
    }
    const priceId =
      payload.data?.items?.[0]?.price?.id ?? payload.data?.items?.[0]?.price_id;
    const mappedPlan = planFromPriceId(priceId);
    return {
      provider: "paddle",
      eventId,
      eventType: payload.event_type,
      accountId: payload.data?.custom_data?.accountId,
      planCode: mappedPlan ?? payload.data?.custom_data?.planCode,
      priceId,
      customerId: payload.data?.customer_id,
      rawHash: sha256(rawBody),
    };
  },
};
