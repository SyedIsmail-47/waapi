import { DisconnectReason } from "@whiskeysockets/baileys";

export type DisconnectAction =
  | { kind: "logged_out" }
  | { kind: "reconnect_immediate" }
  | { kind: "stop_error"; reason: string }
  | { kind: "backoff" };

/**
 * Map Baileys / WhatsApp close status codes to session actions.
 * Verified against @whiskeysockets/baileys@6.7.24 DisconnectReason:
 *   loggedOut=401, forbidden=403, multideviceMismatch=411,
 *   connectionReplaced=440, badSession=500, restartRequired=515
 */
export function mapDisconnectReason(statusCode: number | undefined): DisconnectAction {
  if (statusCode === undefined) return { kind: "backoff" };

  if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
    return { kind: "logged_out" };
  }
  if (statusCode === 515 || statusCode === DisconnectReason.restartRequired) {
    return { kind: "reconnect_immediate" };
  }
  if (
    statusCode === DisconnectReason.connectionReplaced ||
    statusCode === 440
  ) {
    return { kind: "stop_error", reason: "connection_replaced" };
  }
  if (statusCode === DisconnectReason.forbidden || statusCode === 403) {
    return { kind: "stop_error", reason: "forbidden_or_banned" };
  }
  if (statusCode === DisconnectReason.badSession || statusCode === 500) {
    return { kind: "stop_error", reason: "bad_session" };
  }
  if (statusCode === DisconnectReason.multideviceMismatch || statusCode === 411) {
    return { kind: "stop_error", reason: "multidevice_mismatch" };
  }
  return { kind: "backoff" };
}

/** Permanent errors — reconnect must not be rescheduled. Lease-held is transient. */
export const NON_RETRYABLE_OPEN_ERRORS = new Set([
  "SESSION_LOGGED_OUT",
  "SESSION_NOT_FOUND_FOR_ACCOUNT",
  "NODE_SESSION_CAP",
  "SHUTTING_DOWN",
  "CONNECTION_REPLACED",
  "FORBIDDEN_OR_BANNED",
]);

export function isNonRetryableOpenError(err: unknown): boolean {
  const code = err instanceof Error ? err.message : String(err);
  return NON_RETRYABLE_OPEN_ERRORS.has(code);
}
