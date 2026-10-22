import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { BuiltApp } from "./app.js";

/**
 * N4: states × credentials × actions — exact status codes / error codes.
 * Billing GET + delete-account must always succeed when JWT-authenticated.
 */
describe("N4 billing enforcement matrix", () => {
  let app: BuiltApp;
  const password = "correct-horse-battery-staple";

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.DEV_RETURN_TOKENS = "true";
    process.env.SIGNUPS_MODE = "open";
    process.env.BILLING_PROVIDER = "manual";
    process.env.TRIAL_DAYS = "7";
    process.env.TURNSTILE_DISABLED = "true";
    const { buildApp } = await import("./app.js");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  type Creds = {
    accountId: string;
    userId: string;
    jwt: string;
    pat: string;
    sessionKey: string;
    sessionId: string;
  };

  async function provision(label: string, status: "trialing" | "active" | "past_due" | "expired"): Promise<Creds> {
    const email = `n4-${label}-${crypto.randomUUID()}@example.test`;
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password, name: label, acceptTerms: true },
    });
    expect(reg.statusCode).toBe(201);
    const body = reg.json<{ accountId: string; userId: string; verificationToken?: string }>();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      payload: { token: body.verificationToken },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password },
    });
    const jwt = login.json<{ accessToken: string }>().accessToken;

    const { subscriptions, sessions } = await import("@waapi/db");
    const graceUntil =
      status === "past_due" ? new Date(Date.now() + 2 * 86_400_000) : null;
    await app.database.db
      .update(subscriptions)
      .set({
        status,
        planCode: status === "trialing" ? "trial" : "starter",
        graceUntil,
        trialEndsAt: status === "expired" ? new Date(0) : new Date(Date.now() + 86_400_000),
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.accountId, body.accountId));

    // Connected session for send / status / session_key (bypass worker).
    const [sess] = await app.database.db
      .insert(sessions)
      .values({
        accountId: body.accountId,
        name: "n4-sess",
        status: "connected",
        phoneNumber: null,
      })
      .returning();

    const patRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: "n4-pat" },
    });
    expect(patRes.statusCode).toBe(201);
    const pat = patRes.json<{ token: string }>().token;

    const skRes = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sess!.id}/keys`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: "n4-sk" },
    });
    expect(skRes.statusCode).toBe(201);
    const sessionKey = skRes.json<{ token: string }>().token;

    return {
      accountId: body.accountId,
      userId: body.userId,
      jwt,
      pat,
      sessionKey,
      sessionId: sess!.id,
    };
  }

  const states = ["trialing", "active", "past_due", "expired"] as const;
  const credKinds = ["jwt", "pat", "session_key"] as const;

  function authHeader(c: Creds, kind: (typeof credKinds)[number]): string {
    if (kind === "jwt") return `Bearer ${c.jwt}`;
    if (kind === "pat") return `Bearer ${c.pat}`;
    return `Bearer ${c.sessionKey}`;
  }

  function expectAllowedCreateSend(status: (typeof states)[number]): boolean {
    return status !== "expired";
  }

  for (const status of states) {
    describe(`state=${status}`, () => {
      let creds: Creds;

      beforeAll(async () => {
        creds = await provision(status, status);
      });

      for (const kind of credKinds) {
        it(`${kind}: status → 200`, async () => {
          const res = await app.inject({
            method: "GET",
            url: `/api/v1/sessions/${creds.sessionId}/status`,
            headers: { authorization: authHeader(creds, kind) },
          });
          expect(res.statusCode).toBe(200);
        });

        it(`${kind}: list messages → 200`, async () => {
          const res = await app.inject({
            method: "GET",
            url: `/api/v1/messages?sessionId=${creds.sessionId}`,
            headers: { authorization: authHeader(creds, kind) },
          });
          expect(res.statusCode).toBe(200);
        });

        it(`${kind}: billing`, async () => {
          const res = await app.inject({
            method: "GET",
            url: "/api/v1/billing",
            headers: { authorization: authHeader(creds, kind) },
          });
          if (kind === "jwt") {
            expect(res.statusCode).toBe(200);
            expect(res.json<{ status: string }>().status).toBeTruthy();
          } else {
            // billing is JWT-only
            expect([401, 403]).toContain(res.statusCode);
          }
        });

        it(`${kind}: create session`, async () => {
          // bump max_sessions so ACCOUNT_SESSION_CAP does not mask billing
          const { accounts } = await import("@waapi/db");
          await app.database.db
            .update(accounts)
            .set({ maxSessions: 5 })
            .where(eq(accounts.id, creds.accountId));

          const res = await app.inject({
            method: "POST",
            url: "/api/v1/sessions",
            headers: { authorization: authHeader(creds, kind) },
            payload: { name: `create-${kind}-${crypto.randomUUID().slice(0, 8)}` },
          });
          if (kind === "session_key") {
            expect([401, 403]).toContain(res.statusCode);
            return;
          }
          if (expectAllowedCreateSend(status)) {
            expect(res.statusCode).toBe(201);
          } else {
            expect(res.statusCode).toBe(402);
            expect(res.json().error.code).toBe("BILLING_EXPIRED");
          }
        });

        it(`${kind}: send`, async () => {
          const res = await app.inject({
            method: "POST",
            url: "/api/v1/send-message",
            headers: {
              authorization: authHeader(creds, kind),
              "idempotency-key": `n4-${status}-${kind}-${crypto.randomUUID()}`,
            },
            payload: {
              sessionId: creds.sessionId,
              to: "+14155552671",
              text: "n4 matrix",
            },
          });
          if (expectAllowedCreateSend(status)) {
            expect(res.statusCode, JSON.stringify(res.json())).toBe(202);
          } else {
            expect(res.statusCode).toBe(402);
            expect(res.json().error.code).toBe("BILLING_EXPIRED");
          }
        });
      }

      it("jwt: delete account always works", async () => {
        // Fresh account so we do not break other cases mid-suite
        const doomed = await provision(`del-${status}`, status);
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/auth/delete-account",
          headers: { authorization: `Bearer ${doomed.jwt}` },
          payload: { password },
        });
        expect(res.statusCode).toBe(204);
      });
    });
  }
});
