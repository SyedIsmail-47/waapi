import { describe, expect, it } from "vitest";
import { friendlySessionError } from "./friendly-errors";

describe("WP-E friendly session errors", () => {
  it("maps known codes to short user copy", () => {
    expect(friendlySessionError("SESSION_LOGGED_OUT")).toMatch(/logged out/i);
    expect(friendlySessionError("SESSION_NOT_CONNECTED")).toMatch(/not connected/i);
    expect(friendlySessionError("ACCOUNT_SESSION_CAP")).toMatch(/session limit|limit/i);
    expect(friendlySessionError("QR_EXPIRED")).toMatch(/expired/i);
  });

  it("falls back without leaking raw stacks", () => {
    expect(friendlySessionError("Error: at Object.<anonymous> (/tmp/x.ts:1)")).not.toMatch(
      /Object\.|\/tmp/,
    );
    expect(friendlySessionError(null)).toBeNull();
  });
});
