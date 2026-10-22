import { expect, test } from "@playwright/test";

/**
 * Run against the smoke stack dashboard (same-origin nginx on :8080):
 *   docker compose -f docker-compose.yml -f docker-compose.smoke.yml --profile prod up -d --build
 *   pnpm --filter @waapi/dashboard test:e2e
 *
 * Requires SMOKE_MODE + TURNSTILE_DISABLED on the API (see docker-compose.smoke.yml).
 */
test.describe("dashboard smoke", () => {
  const password = "correct-horse-battery-staple";
  const email = `e2e-${Date.now()}@example.com`;

  test("signup → verify (dev token path skipped) → login → sessions empty", async ({
    page,
    request,
  }) => {
    // Register via API so we can verify with DEV path when available, else Mailpit.
    const register = await request.post("/api/v1/auth/register", {
      data: { email, password, name: "E2E", acceptTerms: true },
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
    await expect(page.getByText("No sessions yet")).toBeVisible();

    await page.getByRole("link", { name: "Messages" }).click();
    await expect(page.getByRole("heading", { name: "Message log" })).toBeVisible();

    await page.getByRole("link", { name: "API tokens" }).click();
    await expect(page.getByRole("heading", { name: /Personal access tokens/i })).toBeVisible();
    await page.getByLabel("Name").fill("e2e-pat");
    await page.getByRole("button", { name: "Create token" }).click();
    await expect(page.getByText(/will not be shown again/i)).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();

    await page.getByRole("link", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});
