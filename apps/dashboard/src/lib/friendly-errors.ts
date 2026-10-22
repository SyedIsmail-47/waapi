const COPY: Record<string, string> = {
  SESSION_LOGGED_OUT: "This session is logged out. Connect again to continue.",
  SESSION_NOT_CONNECTED: "Session is not connected. Scan the QR code first.",
  ACCOUNT_SESSION_CAP: "You have reached your session limit for this plan.",
  GLOBAL_SESSION_CAP: "The service is at capacity. Try again later.",
  NODE_SESSION_CAP: "No worker capacity right now. Try again shortly.",
  NODE_LOCK_HELD: "Session is busy on another worker. Retry in a moment.",
  QR_EXPIRED: "QR code expired. Refresh to get a new one.",
  NOT_FOUND: "Session not found.",
  FORBIDDEN: "You do not have access to this session.",
  RATE_LIMITED: "Too many requests. Wait a moment and try again.",
  SESSION_SEND_LIMIT: "Send limit reached for this session. Wait and try again, or upgrade your plan.",
  PHONE_IN_USE: "That WhatsApp number is already linked to another active session.",
  BILLING_EXPIRED: "Your subscription has expired. Update billing to continue.",
};

/** Map API error codes / lastError strings to short dashboard copy. */
export function friendlySessionError(code: string | null | undefined): string | null {
  if (code == null || code === "") return null;
  if (COPY[code]) return COPY[code];
  if (/^[A-Z][A-Z0-9_]+$/.test(code) && code.length < 64) {
    return code.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
  }
  // Never surface stack traces or file paths.
  if (/at\s+\S+|\/[\w.-]+\.\w+:\d+|Error:/i.test(code)) {
    return "Something went wrong. Try again.";
  }
  return code.length > 160 ? `${code.slice(0, 157)}…` : code;
}
