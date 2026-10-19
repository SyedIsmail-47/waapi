import type { SessionStatus } from "@waapi/shared";

export type WAClientEvents = {
  qr: (qr: string) => void;
  status: (status: SessionStatus, detail?: { error?: string; phoneNumber?: string }) => void;
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
  disconnect(): Promise<void>;
  sendText(jid: string, text: string): Promise<{ messageId: string; remoteJid: string }>;
  getStatus(): SessionStatus;
  on<K extends keyof WAClientEvents>(event: K, listener: WAClientEvents[K]): void;
  off<K extends keyof WAClientEvents>(event: K, listener: WAClientEvents[K]): void;
}

export type WAClientFactory = (args: {
  sessionId: string;
  accountId: string;
}) => Promise<WAClient>;
