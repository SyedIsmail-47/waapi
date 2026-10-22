import pino from "pino";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { PINO_REDACT_PATHS, defaultPinoRedact } from "./lib/log-redact.js";

describe("WP-M(a) pino redact paths", () => {
  it("includes authorization, cookie, csrf, token, password, text", () => {
    const joined = PINO_REDACT_PATHS.join("\n");
    expect(joined).toMatch(/authorization/i);
    expect(joined).toMatch(/cookie/i);
    expect(joined).toMatch(/set-cookie/i);
    expect(joined).toMatch(/x-csrf-token/i);
    expect(joined).toMatch(/token/i);
    expect(joined).toMatch(/password/i);
    expect(joined).toMatch(/\.text|body\.text/);
  });

  it("redacts sensitive fields from serialized log lines", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = pino({ level: "info", redact: defaultPinoRedact }, sink);
    log.info({
      req: {
        headers: {
          authorization: "Bearer SUPER_SECRET_ACCESS",
          cookie: "waapi_refresh=SUPER_REFRESH; waapi_csrf=CSRF_SECRET",
          "x-csrf-token": "CSRF_SECRET",
        },
      },
      body: { password: "correct-horse-battery-staple", text: "MESSAGE_BODY_SECRET", token: "TOK" },
      accessToken: "ACCESS_PLAIN",
      refreshToken: "REFRESH_PLAIN",
    });
    const blob = lines.join("\n");
    expect(blob).not.toContain("SUPER_SECRET_ACCESS");
    expect(blob).not.toContain("SUPER_REFRESH");
    expect(blob).not.toContain("CSRF_SECRET");
    expect(blob).not.toContain("MESSAGE_BODY_SECRET");
    expect(blob).not.toContain("ACCESS_PLAIN");
    expect(blob).not.toContain("REFRESH_PLAIN");
    expect(blob).toContain("[Redacted]");
  });
});
