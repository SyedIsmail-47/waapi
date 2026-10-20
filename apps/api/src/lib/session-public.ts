import type { sessions } from "@waapi/db";
import { ERROR_CODES, type ErrorCode } from "@waapi/shared";

const KNOWN = new Set<string>(ERROR_CODES);

const PATTERN_MAP: Array<{ re: RegExp; code: ErrorCode }> = [
  { re: /logged.?out/i, code: "SESSION_LOGGED_OUT" },
  { re: /not.?connected|SESSION_NOT_CONNECTED/i, code: "SESSION_NOT_CONNECTED" },
  { re: /ACCOUNT_SESSION_CAP/i, code: "ACCOUNT_SESSION_CAP" },
  { re: /GLOBAL_SESSION_CAP/i, code: "GLOBAL_SESSION_CAP" },
  { re: /NODE_SESSION_CAP/i, code: "NODE_SESSION_CAP" },
  { re: /lease_renewal_failed/i, code: "NOT_READY" },
  { re: /NODE_LOCK/i, code: "NODE_LOCK_HELD" },
];

/** Map free-form lastError strings to stable API error codes. */
export function mapLastError(lastError: string | null | undefined): string | null {
  if (lastError == null || lastError === "") return null;
  if (KNOWN.has(lastError)) return lastError;
  for (const { re, code } of PATTERN_MAP) {
    if (re.test(lastError)) return code;
  }
  return "INTERNAL_ERROR";
}

type SessionRow = typeof sessions.$inferSelect;

/** Public session DTO — never expose nodeId or authKeyVersion. */
export function toSessionPublic(row: SessionRow) {
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    status: row.status,
    phoneNumber: row.phoneNumber,
    lastError: mapLastError(row.lastError),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
