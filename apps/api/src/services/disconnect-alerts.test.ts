import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, accounts, sessions, users } from "@waapi/db";
import { maybeEnqueueDisconnectAlert } from "./disconnect-alerts.js";
import { buildEmailContent } from "./email.js";

describe("WP-N disconnect alerts", () => {
  const database = createDb(process.env.DATABASE_URL!);

  afterAll(async () => {
    await database.client.end();
  });

  beforeAll(() => {
    process.env.EMAIL_DRIVER = "console";
  });

  it("buildEmailContent renders session_disconnect HTML+text", () => {
    const msg = buildEmailContent({
      to: "a@example.test",
      kind: "session_disconnect",
      sessionName: "Shop",
      reason: "connection_replaced",
    });
    expect(msg.subject).toMatch(/connection replaced/i);
    expect(msg.text).toMatch(/Shop/);
    expect(msg.html).toMatch(/Shop/);
    expect(msg.html).toMatch(/<p>/);
  });

  it("enqueues once then dedupes within 6h; respects opt-out", async () => {
    const accountId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    await database.db.insert(accounts).values({
      id: accountId,
      name: "alert-acct",
      disconnectAlertsOptOut: false,
    });
    await database.db.insert(users).values({
      id: userId,
      accountId,
      email: `alert-${crypto.randomUUID()}@example.test`,
      passwordHash: "x".repeat(60),
      role: "owner",
      emailVerifiedAt: new Date(),
    });
    await database.db.insert(sessions).values({
      id: sessionId,
      accountId,
      name: "AlertSess",
      status: "disconnected",
    });

    const first = await maybeEnqueueDisconnectAlert(
      database,
      accountId,
      sessionId,
      "disconnected",
    );
    expect(first).toBe(true);
    const second = await maybeEnqueueDisconnectAlert(
      database,
      accountId,
      sessionId,
      "disconnected",
    );
    expect(second).toBe(false);

    await database.db
      .update(accounts)
      .set({ disconnectAlertsOptOut: true })
      .where(eq(accounts.id, accountId));
    await database.db
      .update(sessions)
      .set({ lastDisconnectAlertAt: null })
      .where(eq(sessions.id, sessionId));
    const opted = await maybeEnqueueDisconnectAlert(
      database,
      accountId,
      sessionId,
      "logged_out",
    );
    expect(opted).toBe(false);

    await database.db.delete(accounts).where(eq(accounts.id, accountId));
  });
});
