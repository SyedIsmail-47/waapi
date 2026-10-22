import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const edge = readFileSync(resolve(root, "deploy/nginx.conf"), "utf8");
const dash = readFileSync(resolve(root, "apps/dashboard/nginx.conf"), "utf8");

describe("WP-M(b) nginx security headers & blocks", () => {
  it("edge nginx sets HSTS, CSP with Turnstile, nosniff, referrer, frame-ancestors", () => {
    expect(edge).toMatch(/Strict-Transport-Security/i);
    expect(edge).toMatch(/Content-Security-Policy/i);
    expect(edge).toMatch(/challenges\.cloudflare\.com/);
    expect(edge).toMatch(/script-src[^;]*'self'/);
    expect(edge).toMatch(/X-Content-Type-Options\s+nosniff/i);
    expect(edge).toMatch(/Referrer-Policy/i);
    expect(edge).toMatch(/frame-ancestors\s+'?none'?/i);
    expect(edge).toMatch(/client_max_body_size/);
  });

  it("edge nginx hard-blocks /internal and /metrics on public listener", () => {
    expect(edge).toMatch(/location\s+(=\s*)?\/internal/);
    expect(edge).toMatch(/location\s+(=\s*)?\/metrics|location\s+\/metrics/);
    expect(edge).toMatch(/return\s+404/);
  });

  it("edge nginx redirects HTTP to HTTPS", () => {
    expect(edge).toMatch(/listen\s+80/);
    expect(edge).toMatch(/return\s+301\s+https/);
  });

  it("dashboard container nginx blocks /internal and /metrics and sets security headers", () => {
    expect(dash).toMatch(/location\s+\/internal/);
    expect(dash).toMatch(/\/metrics/);
    expect(dash).toMatch(/X-Content-Type-Options/i);
    expect(dash).toMatch(/Content-Security-Policy/i);
    expect(dash).toMatch(/challenges\.cloudflare\.com/);
    expect(dash).toMatch(/client_max_body_size/);
  });
});
