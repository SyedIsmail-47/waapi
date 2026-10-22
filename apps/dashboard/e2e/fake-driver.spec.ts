import { expect, test } from "@playwright/test";

/**
 * Closed-beta smoke with WA_DRIVER=fake.
 * Requires API + worker (fake) + Mailpit or DEV_RETURN_TOKENS + dashboard origin.
 *
 * Env:
 *   DASHBOARD_BASE_URL (default http://127.0.0.1:8080)
 *   ADMIN_API_SECRET
 *   INTERNAL_BASE_URL (default http://127.0.0.1:3001)
 */
const adminSecret = process.env.ADMIN_API_SECRET ?? "";
const internalBase = process.env.INTERNAL_BASE_URL ?? "http://127.0.0.1:3001";

test.describe("fake driver closed-beta path", () => {
  test.skip(!adminSecret, "ADMIN_API_SECRET required for fake scan");

  const password = "correct-horse-battery-staple";
  const email = `fake-e2e-${Date.now()}@example.com`;

  test("signup → verify → login → session → fake scan → connected", async ({
    page,
    request,
  }) => {
    const register = await request.post("/api/v1/auth/register", {
      data: { email, password, name: "FakeE2E" },
    });
    expect(register.ok()).toBeTruthy();
    const body = (await register.json()) as { verificationToken?: string };
    if (body.verificationToken) {
      const verify = await request.post("/api/v1/auth/verify-email", {
        data: { token: body.verificationToken },
      });
      expect(verify.status()).toBe(204);
    }

    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible({
      timeout: 30_000,
    });

    await page.getByLabel("New session name").fill("fake-e2e");
    await page.getByRole("button", { name: "Create session" }).click();
    await expect(page.getByRole("link", { name: "fake-e2e" })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("link", { name: "fake-e2e" }).click();
    await page.getByRole("button", { name: /Connect/i }).click();
    await expect(page.getByText(/Ban risk/i)).toBeVisible();

    // Use API login for bearer (browser cookie jar is separate from this request context).
    const login = await request.post("/api/v1/auth/login", {
      data: { email, password },
    });
    const tokens = (await login.json()) as { accessToken: string };
    const sessions = await request.get("/api/v1/sessions", {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    const rows = (await sessions.json()) as Array<{ id: string; name: string }>;
    const session = rows.find((r) => r.name === "fake-e2e");
    expect(session).toBeTruthy();

    // Connect command
    await request.post(`/api/v1/sessions/${session!.id}/connect`, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    await page.waitForTimeout(500);

    const scan = await request.post(
      `${internalBase}/internal/admin/fake/sessions/${session!.id}/scan`,
      {
        headers: { "x-admin-secret": adminSecret, "content-type": "application/json" },
        data: { phoneNumber: "+15550009999" },
      },
    );
    expect(scan.status()).toBe(202);

    await expect
      .poll(
        async () => {
          const st = await request.get(`/api/v1/sessions/${session!.id}/status`, {
            headers: { authorization: `Bearer ${tokens.accessToken}` },
          });
          const body = (await st.json()) as { status: string };
          return body.status;
        },
        { timeout: 20_000 },
      )
      .toBe("connected");
  });
});
