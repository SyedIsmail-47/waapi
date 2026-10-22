import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuiltApp } from "./app.js";

/** WP-E: rename session + tenant isolation for PATCH. */
describe("WP-E session rename", () => {
  let app: BuiltApp;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.DEV_RETURN_TOKENS = "true";
    process.env.SIGNUPS_MODE = "open";
    const { buildApp } = await import("./app.js");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function registerVerifyLogin(label: string) {
    const email = `${label}-${crypto.randomUUID()}@example.test`;
    const password = "correct-horse-battery-staple";
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password, name: label },
    });
    const body = registered.json<{
      accountId: string;
      verificationToken?: string;
    }>();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      payload: { token: body.verificationToken },
    });
    const loggedIn = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password },
    });
    return {
      accountId: body.accountId,
      accessToken: loggedIn.json<{ accessToken: string }>().accessToken,
    };
  }

  it("PATCH renames session for owner; other tenant gets 404", async () => {
    const [a, b] = await Promise.all([
      registerVerifyLogin("rename-a"),
      registerVerifyLogin("rename-b"),
    ]);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { name: "old-name" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/sessions/${id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { name: "new-name" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ name: string }>().name).toBe("new-name");

    const cross = await app.inject({
      method: "PATCH",
      url: `/api/v1/sessions/${id}`,
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { name: "hijack" },
    });
    expect(cross.statusCode).toBe(404);

    const got = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(got.json<{ name: string }>().name).toBe("new-name");
  });
});
