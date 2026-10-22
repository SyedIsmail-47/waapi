import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@waapi/db";
import { buildApp, type BuiltApp } from "./app.js";
import { CSRF_COOKIE, CSRF_HEADER, REFRESH_COOKIE } from "./lib/auth-cookies.js";

describe("auth cookies + CSRF + /me", () => {
  let app: BuiltApp;
  let database: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = createDb(process.env.DATABASE_URL!);
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.client.end();
  });

  async function registerVerifyLogin(suffix: string) {
    const email = `cookie-${suffix}-${Date.now()}@example.com`;
    const password = "correct-horse-battery-staple";
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {email, password, name: "Cookie User", acceptTerms: true},
    });
    expect(registered.statusCode).toBe(201);
    const body = registered.json<{ verificationToken?: string; userId: string; accountId: string }>();
    expect(body.verificationToken).toBeTruthy();
    const verified = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      payload: { token: body.verificationToken },
    });
    expect(verified.statusCode).toBe(204);
    const loggedIn = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password },
    });
    expect(loggedIn.statusCode).toBe(200);
    return { email, password, loggedIn, ...body };
  }

  function cookieJar(setCookie: string | string[] | undefined): Record<string, string> {
    const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const out: Record<string, string> = {};
    for (const line of headers) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      if (eq < 0) continue;
      out[pair!.slice(0, eq)] = pair!.slice(eq + 1);
    }
    return out;
  }

  it("login sets refresh+csrf cookies; refresh requires CSRF in cookie mode", async () => {
    const { loggedIn } = await registerVerifyLogin("csrf");
    const tokens = loggedIn.json<{ accessToken: string; refreshToken: string }>();
    const jar = cookieJar(loggedIn.headers["set-cookie"]);
    expect(jar[REFRESH_COOKIE]).toBe(tokens.refreshToken);
    expect(jar[CSRF_COOKIE]).toBeTruthy();

    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: {
        [REFRESH_COOKIE]: jar[REFRESH_COOKIE]!,
        [CSRF_COOKIE]: jar[CSRF_COOKIE]!,
      },
      payload: {},
    });
    expect(noCsrf.statusCode).toBe(403);

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: {
        [REFRESH_COOKIE]: jar[REFRESH_COOKIE]!,
        [CSRF_COOKIE]: jar[CSRF_COOKIE]!,
      },
      headers: { [CSRF_HEADER]: jar[CSRF_COOKIE]! },
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ accessToken: string }>().accessToken).toBeTruthy();

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    const profile = me.json<{ email: string; accountName: string }>();
    expect(profile.email).toContain("@example.com");
    expect(profile.accountName).toBeTruthy();
  });

  it("body refresh still works without cookies (API clients)", async () => {
    const { loggedIn } = await registerVerifyLogin("body");
    const tokens = loggedIn.json<{ accessToken: string; refreshToken: string }>();
    const refreshed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json<{ refreshToken: string }>().refreshToken).not.toBe(tokens.refreshToken);
  });
});
