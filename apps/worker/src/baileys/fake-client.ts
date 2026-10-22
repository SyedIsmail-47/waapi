import { randomUUID } from "node:crypto";
import type { SessionStatus } from "@waapi/shared";
import type { StatusDetail, WAClient, WAClientEvents } from "./types.js";

type AnyListener = (...args: never[]) => void;

export type FakeClientOptions = {
  sessionId: string;
  accountId: string;
  /** Delay before first QR emit after connect. */
  qrDelayMs?: number;
  /** Phone number assigned on scan. */
  phoneNumber?: string;
};

type FakeHandle = {
  client: WAClient;
  lastQr: string | null;
  phoneNumber: string | null;
  sendTimeoutNext: boolean;
  emit: <K extends keyof WAClientEvents>(
    event: K,
    ...args: Parameters<WAClientEvents[K]>
  ) => void;
  setStatus: (status: SessionStatus, detail?: StatusDetail) => void;
};

const registry = new Map<string, FakeHandle>();

export const FakeControl = {
  clear(): void {
    registry.clear();
  },
  get(sessionId: string): FakeHandle | undefined {
    return registry.get(sessionId);
  },
  async scan(sessionId: string, phoneNumber?: string): Promise<void> {
    const handle = registry.get(sessionId);
    if (!handle) throw new Error(`Fake session not found: ${sessionId}`);
    const phone = phoneNumber ?? handle.phoneNumber ?? "+15550001111";
    handle.phoneNumber = phone;
    handle.setStatus("connected", { phoneNumber: phone, reconnect: "none" });
  },
  injectSendTimeout(sessionId: string): void {
    const handle = registry.get(sessionId);
    if (!handle) throw new Error(`Fake session not found: ${sessionId}`);
    handle.sendTimeoutNext = true;
  },
  async injectBan(sessionId: string): Promise<void> {
    const handle = registry.get(sessionId);
    if (!handle) throw new Error(`Fake session not found: ${sessionId}`);
    handle.setStatus("error", {
      error: "banned_or_restricted",
      reconnect: "none",
    });
  },
  async injectInbound(
    sessionId: string,
    input: { remoteJid: string; text?: string; messageId?: string },
  ): Promise<void> {
    const handle = registry.get(sessionId);
    if (!handle) throw new Error(`Fake session not found: ${sessionId}`);
    handle.emit("messageMeta", {
      remoteJid: input.remoteJid,
      messageId: input.messageId ?? `fake-in-${randomUUID()}`,
      fromMe: false,
      messageType: "conversation",
      ...(input.text != null ? { text: input.text } : {}),
    });
  },
};

export async function createFakeClient(opts: FakeClientOptions): Promise<WAClient> {
  const { sessionId, accountId } = opts;
  const qrDelayMs = opts.qrDelayMs ?? 50;
  const listeners = new Map<keyof WAClientEvents, Set<AnyListener>>();
  let status: SessionStatus = "connecting";
  let disposed = false;
  let qrTimer: ReturnType<typeof setTimeout> | null = null;
  let qrSeq = 0;

  const emit = <K extends keyof WAClientEvents>(
    event: K,
    ...eventArgs: Parameters<WAClientEvents[K]>
  ) => {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      (fn as (...a: unknown[]) => void)(...eventArgs);
    }
  };

  const setStatus = (next: SessionStatus, detail?: StatusDetail) => {
    status = next;
    emit("status", next, detail);
  };

  const client: WAClient = {
    sessionId,
    accountId,
    async connect() {
      if (disposed) throw new Error("Fake client disposed");
      setStatus("connecting");
      if (qrTimer) clearTimeout(qrTimer);
      qrTimer = setTimeout(() => {
        qrSeq += 1;
        const qr = `FAKE-QR-${sessionId.slice(0, 8)}-${qrSeq}`;
        const handle = registry.get(sessionId);
        if (handle) handle.lastQr = qr;
        emit("qr", qr);
      }, qrDelayMs);
    },
    async disconnect(opts?: { flush?: boolean }) {
      if (opts?.flush !== false) await client.flushAuth();
      if (qrTimer) {
        clearTimeout(qrTimer);
        qrTimer = null;
      }
      setStatus("disconnected");
    },
    async flushAuth() {
      /* no-op for fake */
    },
    closeAuth() {
      /* no-op for fake */
    },
    dispose() {
      disposed = true;
      if (qrTimer) {
        clearTimeout(qrTimer);
        qrTimer = null;
      }
      listeners.clear();
      registry.delete(sessionId);
    },
    async sendText(jid: string, _text: string) {
      void _text; // intentionally unused — never log bodies
      if (status !== "connected") {
        throw Object.assign(new Error("Session not connected"), {
          statusCode: 409,
          code: "SESSION_NOT_READY",
        });
      }
      const handle = registry.get(sessionId);
      if (handle?.sendTimeoutNext) {
        handle.sendTimeoutNext = false;
        throw Object.assign(new Error("Send timeout"), {
          statusCode: 504,
          code: "SEND_TIMEOUT",
        });
      }
      const remoteJid = jid.includes("@") ? jid : `${jid}@s.whatsapp.net`;
      const messageId = `fake-${randomUUID()}`;
      emit("messageMeta", {
        remoteJid,
        messageId,
        fromMe: true,
        messageType: "conversation",
      });
      return { messageId, remoteJid };
    },
    getStatus() {
      return status;
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener as AnyListener);
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener as AnyListener);
    },
  };

  registry.set(sessionId, {
    client,
    lastQr: null,
    phoneNumber: opts.phoneNumber ?? null,
    sendTimeoutNext: false,
    emit,
    setStatus,
  });

  return client;
}
