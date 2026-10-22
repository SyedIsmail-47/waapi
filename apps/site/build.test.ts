import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const siteRoot = resolve(root, "apps/site");
const dist = resolve(siteRoot, "dist-test-wpj");

const PAGES = ["", "pricing", "docs", "terms", "privacy", "refund", "aup", "contact"] as const;

describe("WP-J public site build", () => {
  it("prerenders static HTML for all marketing routes with DRAFT legal + disclaimer", () => {
    rmSync(dist, { recursive: true, force: true });
    execFileSync(
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["--filter", "@waapi/site", "build"],
      {
        cwd: root,
        env: {
          ...process.env,
          SITE_DIST: "dist-test-wpj",
          NODE_ENV: "development",
          BRAND_NAME: "waapi",
          LEGAL_NAME: "LEGAL_NAME",
          LEGAL_ADDRESS: "[registered address]",
          MERCHANT_OF_RECORD: "false",
          PUBLIC_APP_URL: "https://app.example.com",
          CONTACT_EMAIL: "support@example.com",
          // clear price overrides from other parallel tests
          PLAN_PRICE_STARTER: "",
          PLAN_PRICE_PRO: "",
          PLAN_PRICE_ENTERPRISE: "",
        },
        stdio: "pipe",
        shell: process.platform === "win32",
      },
    );

    for (const page of PAGES) {
      const file = page === "" ? resolve(dist, "index.html") : resolve(dist, page, "index.html");
      expect(existsSync(file), `missing ${file}`).toBe(true);
      const html = readFileSync(file, "utf8");
      expect(html).toMatch(/waapi/i);
      expect(html).toMatch(/not affiliated with WhatsApp|Meta/i);
      expect(html).toMatch(/ban risk/i);
      if (["terms", "privacy", "refund", "aup"].includes(page)) {
        expect(html).toMatch(/DRAFT/i);
        expect(html).toMatch(/LEGAL_NAME/);
      }
    }

    const pricing = readFileSync(resolve(dist, "pricing", "index.html"), "utf8");
    expect(pricing).toMatch(/Starter|Pro|Enterprise/);
    expect(pricing).not.toMatch(/sk_|pat_|SECRET|PASSWORD/i);

    const terms = readFileSync(resolve(dist, "terms", "index.html"), "utf8");
    expect(terms).not.toMatch(/merchant of record/i);
  });

  it("includes merchant-of-record clause when MERCHANT_OF_RECORD=true", () => {
    const morDist = resolve(siteRoot, "dist-test-mor");
    rmSync(morDist, { recursive: true, force: true });
    execFileSync(
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["--filter", "@waapi/site", "build"],
      {
        cwd: root,
        env: {
          ...process.env,
          SITE_DIST: "dist-test-mor",
          NODE_ENV: "development",
          BRAND_NAME: "waapi",
          LEGAL_NAME: "Acme Legal LLC",
          LEGAL_ADDRESS: "1 Main St",
          MERCHANT_OF_RECORD: "true",
          PUBLIC_APP_URL: "https://app.acme-legal.test",
          CONTACT_EMAIL: "support@acme-legal.test",
          PLAN_PRICE_STARTER: "$29/mo",
          PLAN_PRICE_PRO: "$99/mo",
          PLAN_PRICE_ENTERPRISE: "Custom",
        },
        stdio: "pipe",
        shell: process.platform === "win32",
      },
    );
    const terms = readFileSync(resolve(morDist, "terms", "index.html"), "utf8");
    expect(terms).toMatch(/merchant of record/i);
  });
});
