import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { BuiltApp } from "../../app.js";

/**
 * N2/N3: fixtures per Paddle event — raw bytes ≠ JSON.stringify(JSON.parse(raw)).
 * Current Paddle Billing events (2026): subscription.updated|paused|resumed and
 * adjustment.* (refunds/chargebacks) are ambiguous/risk-bearing → manual review
 * only, no auto plan/status change, no auto-suspend. transaction.completed /
 * subscription.activated / payment_failed / subscription.past_due /
 * subscription.canceled still drive the state machine directly.
 */
describe("N2/N3 Paddle event fixtures", () => {
  let app: BuiltApp;
  const secret = "paddle-n3-webhook-secret-32chars!!";

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.BILLING_PROVIDER = "paddle";
    process.env.PADDLE_WEBHOOK_SECRET = secret;
    process.env.PADDLE_API_KEY = "paddle_test_key";
    process.env.PADDLE_PRICE_IDS_JSON = JSON.stringify({
      starter: "pri_starter_n3",
      pro: "pri_pro_n3",
    });
    process.env.SIGNUPS_MODE = "open";
    process.env.DEV_RETURN_TOKENS = "true";
    process.env.TURNSTILE_DISABLED = "true";
    const { buildApp } = await import("../../app.js");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  function sign(raw: string, ts = Math.floor(Date.now() / 1000)) {
    const h1 = createHmac("sha256", secret).update(`${ts}:${raw}`).digest("hex");
    return `ts=${ts};h1=${h1}`;
  }

  async function post(raw: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/billing/webhooks/paddle",
      headers: {
        "content-type": "application/json",
        "paddle-signature": sign(raw),
      },
      payload: Buffer.from(raw, "utf8"),
    });
  }

  async function seedAccount(label: string) {
    const accountId = crypto.randomUUID();
    const { accounts } = await import("@waapi/db");
    await app.database.db.insert(accounts).values({ id: accountId, name: label });
    const { ensureSubscription } = await import("./index.js");
    await ensureSubscription(app.database, accountId);
    return accountId;
  }

  function spacedRaw(parts: Record<string, unknown>): string {
    // Deliberate whitespace + key order so raw !== JSON.stringify(JSON.parse(raw))
    const eventId = parts.event_id as string;
    const eventType = parts.event_type as string;
    const data = JSON.stringify(parts.data);
    const raw = `{  "event_type" : "${eventType}" , "event_id":"${eventId}" , "data": ${data} }`;
    expect(raw).not.toBe(JSON.stringify(JSON.parse(raw)));
    return raw;
  }

  it("subscription.updated flags manual review (no auto plan/status change); binds customer; mismatched account ignored", async () => {
    const accountId = await seedAccount("n3-updated");
    const customerId = `ctm_${crypto.randomUUID().slice(0, 8)}`;
    const raw = spacedRaw({
      event_id: `evt_upd_${crypto.randomUUID()}`,
      event_type: "subscription.updated",
      data: {
        id: "sub_1",
        customer_id: customerId,
        custom_data: { accountId, planCode: "starter" },
        items: [{ price: { id: "pri_pro_n3" } }],
        scheduled_change: { action: "cancel" },
      },
    });
    const res = await post(raw);
    expect(res.statusCode).toBe(200);
    const { subscriptions, accounts: accts } = await import("@waapi/db");
    const [sub] = await app.database.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId));
    // No auto plan/status change — the event only flags manual review.
    expect(sub?.status).toBe("trialing");
    expect(sub?.planCode).toBe("trial");
    // Customer binding (N2) still happens regardless of manual-review routing.
    expect(sub?.providerCustomerId).toBe(customerId);
    const [acct] = await app.database.db.select().from(accts).where(eq(accts.id, accountId));
    expect(acct?.manualReviewAt).toBeTruthy();
    expect(acct?.manualReviewReason).toBe("subscription.updated");
    expect(acct?.suspendedAt).toBeNull();

    // Mismatched custom_data account for same customer → ignore (not bound/flagged).
    const other = await seedAccount("n3-mismatch");
    const bad = spacedRaw({
      event_id: `evt_bad_${crypto.randomUUID()}`,
      event_type: "subscription.updated",
      data: {
        customer_id: customerId,
        custom_data: { accountId: other },
        items: [{ price: { id: "pri_starter_n3" } }],
      },
    });
    const ignored = await post(bad);
    expect(ignored.statusCode).toBe(200);
    const [otherSub] = await app.database.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, other));
    expect(otherSub?.providerCustomerId).not.toBe(customerId);
    const [otherAcct] = await app.database.db.select().from(accts).where(eq(accts.id, other));
    expect(otherAcct?.manualReviewAt).toBeNull();

    await app.database.db.delete(accts).where(eq(accts.id, accountId));
    await app.database.db.delete(accts).where(eq(accts.id, other));
  });

  it("unknown price → ignore + audit", async () => {
    const accountId = await seedAccount("n3-unk");
    const { accounts, securityAuditLog } = await import("@waapi/db");
    const raw = spacedRaw({
      event_id: `evt_unk_${crypto.randomUUID()}`,
      event_type: "subscription.activated",
      data: {
        customer_id: `ctm_unk_${crypto.randomUUID().slice(0, 6)}`,
        custom_data: { accountId },
        items: [{ price: { id: "pri_not_allowlisted" } }],
      },
    });
    expect((await post(raw)).statusCode).toBe(200);
    const audits = await app.database.db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.accountId, accountId));
    expect(audits.some((a) => a.eventType === "billing.unknown_price")).toBe(true);
    await app.database.db.delete(accounts).where(eq(accounts.id, accountId));
  });

  it("subscription.activated applies plan change from allowlisted price", async () => {
    const accountId = await seedAccount("n3-activated");
    const raw = spacedRaw({
      event_id: `evt_act_${crypto.randomUUID()}`,
      event_type: "subscription.activated",
      data: {
        customer_id: `ctm_act_${crypto.randomUUID().slice(0, 6)}`,
        custom_data: { accountId, planCode: "starter" },
        items: [{ price: { id: "pri_starter_n3" } }],
      },
    });
    expect((await post(raw)).statusCode).toBe(200);
    const { accounts, subscriptions } = await import("@waapi/db");
    const [sub] = await app.database.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId));
    expect(sub?.status).toBe("active");
    expect(sub?.planCode).toBe("starter");
    await app.database.db.delete(accounts).where(eq(accounts.id, accountId));
  });

  it("subscription.paused / resumed flags manual review (no auto-suspend)", async () => {
    const accountId = await seedAccount("n3-pause");
    const { accounts: accts, subscriptions } = await import("@waapi/db");
    await app.database.db
      .update(subscriptions)
      .set({ status: "active", planCode: "starter" })
      .where(eq(subscriptions.accountId, accountId));

    const customerId = `ctm_p_${crypto.randomUUID().slice(0, 6)}`;
    const pauseRaw = spacedRaw({
      event_id: `evt_pause_${crypto.randomUUID()}`,
      event_type: "subscription.paused",
      data: {
        customer_id: customerId,
        custom_data: { accountId },
        items: [{ price: { id: "pri_starter_n3" } }],
      },
    });
    expect((await post(pauseRaw)).statusCode).toBe(200);
    let [sub] = await app.database.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId));
    // No auto-suspend — status unchanged, account flagged for manual review instead.
    expect(sub?.status).toBe("active");
    let [acct] = await app.database.db.select().from(accts).where(eq(accts.id, accountId));
    expect(acct?.manualReviewAt).toBeTruthy();
    expect(acct?.manualReviewReason).toBe("subscription.paused");

    const resumeRaw = spacedRaw({
      event_id: `evt_resume_${crypto.randomUUID()}`,
      event_type: "subscription.resumed",
      data: {
        customer_id: customerId,
        custom_data: { accountId },
        items: [{ price: { id: "pri_starter_n3" } }],
      },
    });
    expect((await post(resumeRaw)).statusCode).toBe(200);
    [sub] = await app.database.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId));
    expect(sub?.status).toBe("active"); // still unchanged
    [acct] = await app.database.db.select().from(accts).where(eq(accts.id, accountId));
    expect(acct?.manualReviewReason).toBe("subscription.resumed");

    await app.database.db.delete(accts).where(eq(accts.id, accountId));
  });

  it("adjustment.created flags manual review (no suspend)", async () => {
    const accountId = await seedAccount("n3-adj");
    const { accounts } = await import("@waapi/db");
    const raw = spacedRaw({
      event_id: `evt_adj_${crypto.randomUUID()}`,
      event_type: "adjustment.created",
      data: {
        customer_id: `ctm_a_${crypto.randomUUID().slice(0, 6)}`,
        custom_data: { accountId },
        action: "refund",
      },
    });
    expect((await post(raw)).statusCode).toBe(200);
    const [acct] = await app.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId));
    expect(acct?.manualReviewAt).toBeTruthy();
    expect(acct?.suspendedAt).toBeNull();
    await app.database.db.delete(accounts).where(eq(accounts.id, accountId));
  });

  it("transaction.completed applies payment_succeeded transition", async () => {
    const accountId = await seedAccount("n3-txn");
    const raw = spacedRaw({
      event_id: `evt_txn_${crypto.randomUUID()}`,
      event_type: "transaction.completed",
      data: {
        customer_id: `ctm_txn_${crypto.randomUUID().slice(0, 6)}`,
        custom_data: { accountId, planCode: "starter" },
        items: [{ price: { id: "pri_starter_n3" } }],
      },
    });
    expect((await post(raw)).statusCode).toBe(200);
    const { accounts, subscriptions } = await import("@waapi/db");
    const [sub] = await app.database.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId));
    expect(sub?.status).toBe("active");
    expect(sub?.planCode).toBe("starter");
    await app.database.db.delete(accounts).where(eq(accounts.id, accountId));
  });

  it("subscription.past_due applies payment_failed transition (grace window)", async () => {
    const accountId = await seedAccount("n3-pastdue");
    const { accounts, subscriptions } = await import("@waapi/db");
    await app.database.db
      .update(subscriptions)
      .set({ status: "active", planCode: "starter" })
      .where(eq(subscriptions.accountId, accountId));
    const raw = spacedRaw({
      event_id: `evt_pd_${crypto.randomUUID()}`,
      event_type: "subscription.past_due",
      data: {
        customer_id: `ctm_pd_${crypto.randomUUID().slice(0, 6)}`,
        custom_data: { accountId },
        items: [{ price: { id: "pri_starter_n3" } }],
      },
    });
    expect((await post(raw)).statusCode).toBe(200);
    const [sub] = await app.database.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId));
    expect(sub?.status).toBe("past_due");
    expect(sub?.graceUntil).toBeTruthy();
    await app.database.db.delete(accounts).where(eq(accounts.id, accountId));
  });

  it("subscription.canceled applies canceled transition", async () => {
    const accountId = await seedAccount("n3-canceled");
    const { accounts, subscriptions } = await import("@waapi/db");
    await app.database.db
      .update(subscriptions)
      .set({ status: "active", planCode: "starter" })
      .where(eq(subscriptions.accountId, accountId));
    const raw = spacedRaw({
      event_id: `evt_cancel_${crypto.randomUUID()}`,
      event_type: "subscription.canceled",
      data: {
        customer_id: `ctm_cancel_${crypto.randomUUID().slice(0, 6)}`,
        custom_data: { accountId },
        items: [{ price: { id: "pri_starter_n3" } }],
      },
    });
    expect((await post(raw)).statusCode).toBe(200);
    const [sub] = await app.database.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId));
    expect(sub?.status).toBe("canceled");
    await app.database.db.delete(accounts).where(eq(accounts.id, accountId));
  });
});
