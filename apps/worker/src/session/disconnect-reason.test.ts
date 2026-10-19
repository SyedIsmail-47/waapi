import { describe, expect, it } from "vitest";
import { DisconnectReason } from "@whiskeysockets/baileys";
import {
  isNonRetryableOpenError,
  mapDisconnectReason,
  NON_RETRYABLE_OPEN_ERRORS,
} from "./disconnect-reason.js";

describe("Baileys DisconnectReason pin (6.7.24)", () => {
  it("matches expected numeric codes", () => {
    expect(DisconnectReason.loggedOut).toBe(401);
    expect(DisconnectReason.forbidden).toBe(403);
    expect(DisconnectReason.multideviceMismatch).toBe(411);
    expect(DisconnectReason.connectionReplaced).toBe(440);
    expect(DisconnectReason.badSession).toBe(500);
    expect(DisconnectReason.restartRequired).toBe(515);
  });
});

describe("mapDisconnectReason", () => {
  it("maps 401 / loggedOut to logged_out", () => {
    expect(mapDisconnectReason(401)).toEqual({ kind: "logged_out" });
    expect(mapDisconnectReason(DisconnectReason.loggedOut)).toEqual({ kind: "logged_out" });
  });

  it("maps 515 / restartRequired to reconnect_immediate", () => {
    expect(mapDisconnectReason(515)).toEqual({ kind: "reconnect_immediate" });
    expect(mapDisconnectReason(DisconnectReason.restartRequired)).toEqual({
      kind: "reconnect_immediate",
    });
  });

  it("maps 440 connectionReplaced to stop_error", () => {
    expect(mapDisconnectReason(440)).toEqual({
      kind: "stop_error",
      reason: "connection_replaced",
    });
  });

  it("maps 403 / forbidden to stop_error ban-like", () => {
    expect(mapDisconnectReason(403)).toEqual({
      kind: "stop_error",
      reason: "forbidden_or_banned",
    });
  });

  it("maps badSession (500) and multideviceMismatch (411) to stop_error", () => {
    expect(mapDisconnectReason(500)).toEqual({ kind: "stop_error", reason: "bad_session" });
    expect(mapDisconnectReason(DisconnectReason.badSession)).toEqual({
      kind: "stop_error",
      reason: "bad_session",
    });
    expect(mapDisconnectReason(411)).toEqual({
      kind: "stop_error",
      reason: "multidevice_mismatch",
    });
    expect(mapDisconnectReason(DisconnectReason.multideviceMismatch)).toEqual({
      kind: "stop_error",
      reason: "multidevice_mismatch",
    });
  });

  it("maps other codes to backoff", () => {
    expect(mapDisconnectReason(408)).toEqual({ kind: "backoff" });
    expect(mapDisconnectReason(428)).toEqual({ kind: "backoff" });
    expect(mapDisconnectReason(undefined)).toEqual({ kind: "backoff" });
  });
});

describe("isNonRetryableOpenError", () => {
  it("treats SESSION_LEASE_HELD as retryable (transient)", () => {
    expect(NON_RETRYABLE_OPEN_ERRORS.has("SESSION_LEASE_HELD")).toBe(false);
    expect(isNonRetryableOpenError(new Error("SESSION_LEASE_HELD"))).toBe(false);
  });

  it("recognizes permanent open errors", () => {
    for (const code of NON_RETRYABLE_OPEN_ERRORS) {
      expect(isNonRetryableOpenError(new Error(code))).toBe(true);
    }
  });
});
