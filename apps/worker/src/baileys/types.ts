import type { SessionStatus } from "@waapi/shared";

export type StatusDetail = {
  error?: string;
  phoneNumber?: string;
  /** How the manager should treat this status for reconnect. */
  reconnect?: "immediate" | "backoff" | "none";
};

export type WAClientEvents = {
  qr: (qr: string) => void;
  status: (status: SessionStatus, detail?: StatusDetail) => void;
  /** Metadata only — never include message body fields. */
  messageMeta: (meta: {
    remoteJid: string;
    messageId: string;
    fromMe: boolean;
    messageType: string;
  }) => void;
  loggedOut: () => void;
};

export interface WAClient {
  readonly sessionId: string;
  readonly accountId: string;
  connect(): Promise<void>;
  /**
   * End the socket. By default flushes auth writes (5s timeout) then closes.
   * Pass `{ flush: false }` on logout (closeAuth → wipe already done; no flush).
   */
  disconnect(opts?: { flush?: boolean }): Promise<void>;
  /** Await queued auth-state writes (saveCreds / keys). */
  flushAuth(): Promise<void>;
  /** Block auth-state writes. Call before wipeAuth / disconnect on logout. */
  closeAuth(): void;
  /** Remove all event listeners and release socket resources. */
  dispose(): void;
  sendText(jid: string, text: string): Promise<{ messageId: string; remoteJid: string }>;
  getStatus(): SessionStatus;
  on<K extends keyof WAClientEvents>(event: K, listener: WAClientEvents[K]): void;
  off<K extends keyof WAClientEvents>(event: K, listener: WAClientEvents[K]): void;
}

export type WAClientFactory = (args: {
  sessionId: string;
  accountId: string;
}) => Promise<WAClient>;
