import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users, type Db } from "@waapi/db";
import { CURRENT_TERMS_VERSION } from "@waapi/shared";
import type { BuiltApp } from "./app.js";

describe("WP-J terms acceptance", () => {
  let app: BuiltApp;
  let database: Db;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.DEV_RETURN_TOKENS = "true";
    process.env.SIGNUPS_MODE = "open";
    const { buildApp } = await import("./app.js");
    app = await buildApp();
    database = app.database;
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("rejects register without acceptTerms", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: `no-terms-${crypto.randomUUID()}@example.test`,
        password: "correct-horse-battery-staple",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toMatch(/TERMS|VALIDATION/i);
  });

  it("stores terms_version and terms_accepted_at on signup", async () => {
    const email = `terms-ok-${crypto.randomUUID()}@example.test`;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email,
        password: "correct-horse-battery-staple",
        name: "Terms User",
        acceptTerms: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const { userId } = res.json<{ userId: string }>();
    const [row] = await database.db
      .select({
        termsVersion: users.termsVersion,
        termsAcceptedAt: users.termsAcceptedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(row?.termsVersion).toBe(CURRENT_TERMS_VERSION);
    expect(row?.termsAcceptedAt).toBeInstanceOf(Date);
  });

  it("rejects acceptTerms: false", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: `terms-false-${crypto.randomUUID()}@example.test`,
        password: "correct-horse-battery-staple",
        acceptTerms: false,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
