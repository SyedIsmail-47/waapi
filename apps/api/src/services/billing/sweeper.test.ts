import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, accounts, sessions, subscriptions } from "@waapi/db";
import { ensureSubscription, sweepBillingExpirations } from "./index.js";

describe("WP-N billing sweeper", () => {
  const database = createDb(process.env.DATABASE_URL!);

  afterAll(async () => {
    await database.client.end();
  });

  beforeAll(async () => {
    process.env.BILLING_PROVIDER = "manual";
  });

  it("expires trial past trialEndsAt and past_due past grace", async () => {
    const trialId = crypto.randomUUID();
    const graceId = crypto.randomUUID();
    await database.db.insert(accounts).values([
      { id: trialId, name: "sweep-trial" },
      { id: graceId, name: "sweep-grace" },
    ]);
    await ensureSubscription(database, trialId);
    await ensureSubscription(database, graceId);
    await database.db
      .update(subscriptions)
      .set({ status: "trialing", trialEndsAt: new Date(Date.now() - 60_000) })
      .where(eq(subscriptions.accountId, trialId));
    await database.db
      .update(subscriptions)
      .set({
        status: "past_due",
        graceUntil: new Date(Date.now() - 60_000),
        planCode: "starter",
      })
      .where(eq(subscriptions.accountId, graceId));

    // Extra session on grace account (max 1 for starter after expire → disconnect extras)
    await database.db.insert(sessions).values([
      { accountId: graceId, name: "s1", status: "connected" },
      { accountId: graceId, name: "s2", status: "connected" },
    ]);

    const n = await sweepBillingExpirations(database);
    expect(n).toBeGreaterThanOrEqual(2);

    const [t] = await database.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, trialId));
    const [g] = await database.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, graceId));
    expect(t?.status).toBe("expired");
    expect(g?.status).toBe("expired");

    await database.db.delete(accounts).where(eq(accounts.id, trialId));
    await database.db.delete(accounts).where(eq(accounts.id, graceId));
  });
});
