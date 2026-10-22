import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function runBuild(env: NodeJS.ProcessEnv): { status: number; stderr: string; stdout: string } {
  try {
    const out = execFileSync(
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["--filter", "@waapi/site", "build"],
      {
        cwd: root,
        env: { ...process.env, ...env },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      },
    );
    return { status: 0, stdout: String(out), stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer | string; stdout?: Buffer | string };
    return {
      status: e.status ?? 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
    };
  }
}

describe("WP-M(e) site build placeholder guard", () => {
  it("fails in production when LEGAL_NAME is placeholder", () => {
    const r = runBuild({
      NODE_ENV: "production",
      BRAND_NAME: "waapi",
      LEGAL_NAME: "LEGAL_NAME",
      LEGAL_ADDRESS: "1 Example Street",
      CONTACT_EMAIL: "support@example.com",
      PUBLIC_APP_URL: "https://app.example.com",
      MERCHANT_OF_RECORD: "false",
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}\n${r.stdout}`).toMatch(/LEGAL_NAME|placeholder/i);
  });

  it("fails when MERCHANT_OF_RECORD=true and CONTACT_EMAIL missing/placeholder", () => {
    const r = runBuild({
      NODE_ENV: "development",
      BRAND_NAME: "waapi",
      LEGAL_NAME: "Acme Legal LLC",
      LEGAL_ADDRESS: "1 Main St",
      CONTACT_EMAIL: "support@example.com",
      PUBLIC_APP_URL: "https://app.example.com",
      MERCHANT_OF_RECORD: "true",
    });
    // support@example.com is allowed as contact in non-prod unless we treat example.com as placeholder
    // Require real domain when MOR is set — example.com should fail
    expect(r.status).not.toBe(0);
  });

  it("succeeds with real legal fields in production", () => {
    const r = runBuild({
      NODE_ENV: "production",
      BRAND_NAME: "waapi",
      LEGAL_NAME: "Acme Legal LLC",
      LEGAL_ADDRESS: "100 Market Street, City",
      CONTACT_EMAIL: "support@acme-legal.test",
      PUBLIC_APP_URL: "https://app.acme-legal.test",
      MERCHANT_OF_RECORD: "true",
      PLAN_PRICE_STARTER: "$29/mo",
      PLAN_PRICE_PRO: "$99/mo",
      PLAN_PRICE_ENTERPRISE: "Contact",
    });
    expect(r.status).toBe(0);
  });
});
