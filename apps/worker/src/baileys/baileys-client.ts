import makeWASocket, {
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { pino } from "pino";
import type { SessionStatus } from "@waapi/shared";
import type { WorkerConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import { mapDisconnectReason } from "../session/disconnect-reason.js";
import { usePostgresAuthState, type PostgresAuthState } from "./auth-state.js";
import type { StatusDetail, WAClient, WAClientEvents } from "./types.js";

type AnyListener = (...args: never[]) => void;

function messageTypeOf(msg: Record<string, unknown> | null | undefined): string {
  if (!msg) return "unknown";
  const keys = Object.keys(msg).filter((k) => k !== "messageContextInfo");
  return keys[0] ?? "unknown";
}

/** Extract conversation / extended-text body for webhook payloads (not for logs). */
function messageTextOf(msg: Record<string, unknown> | null | undefined): string | undefined {
  if (!msg) return undefined;
  if (typeof msg.conversation === "string" && msg.conversation.length) {
    return msg.conversation;
  }
  const ext = msg.extendedTextMessage;
  if (ext && typeof ext === "object" && ext !== null) {
    const text = (ext as { text?: unknown }).text;
    if (typeof text === "string" && text.length) return text;
  }
  return undefined;
}

export async function createBaileysClient(args: {
  sessionId: string;
  accountId: string;
  db: Db["db"];
  cfg: WorkerConfig;
  log: Logger;
}): Promise<WAClient> {
  const { sessionId, accountId, db, cfg, log } = args;
  const listeners = new Map<keyof WAClientEvents, Set<AnyListener>>();
  let status: SessionStatus = "connecting";
  let sock: WASocket | null = null;
  let closedByUs = false;
  let auth: PostgresAuthState | null = null;
  /** Ensures a single logout path: loggedOut event only (no status=logged_out emit). */
  let logoutEmitted = false;

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

  auth = await usePostgresAuthState({
    db,
    sessionId,
    accountId,
    keyRing: cfg.keyRing,
  });

  const detachSocket = () => {
    if (!sock) return;
    try {
      sock.ev.removeAllListeners("creds.update");
      sock.ev.removeAllListeners("connection.update");
      sock.ev.removeAllListeners("messages.upsert");
    } catch {
      /* ignore */
    }
  };

  const connect = async (): Promise<void> => {
    closedByUs = false;
    logoutEmitted = false;
    setStatus("connecting");
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
      version,
      auth: auth!.state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", () => {
      void auth!
        .saveCreds()
        .catch((err) => {
          log.error({ err, sessionId }, "saveCreds failed");
        });
    });

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        setStatus("need_scan");
        emit("qr", qr);
        if (cfg.nodeEnv === "development") {
          log.info({ sessionId, event: "qr" }, "qr updated");
        }
      }
      if (connection === "open") {
        const phone = sock?.user?.id ? jidNormalizedUser(sock.user.id).split("@")[0] : undefined;
        setStatus("connected", { phoneNumber: phone });
      }
      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        if (closedByUs) {
          setStatus("disconnected", { reconnect: "none" });
          return;
        }
        const action = mapDisconnectReason(statusCode);
        const errMsg = lastDisconnect?.error?.message ?? "connection closed";
        if (action.kind === "logged_out") {
          // Single logout path: emit loggedOut once; manager handles DB wipe/status.
          // Do NOT also emit status "logged_out" (avoids dual handlers).
          if (!logoutEmitted) {
            logoutEmitted = true;
            emit("loggedOut");
          }
          status = "logged_out";
          return;
        }
        if (action.kind === "reconnect_immediate") {
          setStatus("disconnected", { error: errMsg, reconnect: "immediate" });
          return;
        }
        if (action.kind === "stop_error") {
          setStatus("error", { error: action.reason, reconnect: "none" });
          return;
        }
        setStatus("disconnected", { error: errMsg, reconnect: "backoff" });
      }
    });

    sock.ev.on("messages.upsert", (upsert) => {
      if (upsert.type !== "notify") return;
      for (const msg of upsert.messages) {
        const remoteJid = msg.key.remoteJid;
        const messageId = msg.key.id;
        if (!remoteJid || !messageId) continue;
        const message = msg.message as Record<string, unknown> | null;
        const meta = {
          remoteJid,
          messageId,
          fromMe: Boolean(msg.key.fromMe),
          messageType: messageTypeOf(message),
          text: messageTextOf(message),
        };
        // Never log message text.
        log.info(
          {
            sessionId,
            event: "messages.upsert",
            remoteJid: meta.remoteJid,
            messageId: meta.messageId,
            fromMe: meta.fromMe,
            messageType: meta.messageType,
          },
          "inbound message metadata",
        );
        emit("messageMeta", meta);
      }
    });
  };

  const client: WAClient = {
    sessionId,
    accountId,
    async connect() {
      await connect();
    },
    async flushAuth() {
      if (!auth) return;
      await auth.flush();
    },
    async disconnect(opts?: { flush?: boolean }) {
      closedByUs = true;
      const shouldFlush = opts?.flush !== false;
      if (shouldFlush && auth) {
        // Flush with 5s timeout; on timeout log warning and continue closing.
        const FLUSH_TIMEOUT_MS = 5_000;
        try {
          let timedOut = false;
          await Promise.race([
            auth.flush(),
            new Promise<void>((resolve) => {
              setTimeout(() => {
                timedOut = true;
                resolve();
              }, FLUSH_TIMEOUT_MS);
            }),
          ]);
          if (timedOut) {
            log.warn({ sessionId, timeoutMs: FLUSH_TIMEOUT_MS }, "auth flush timed out on disconnect");
          }
        } catch (err) {
          log.error({ err, sessionId }, "auth flush on disconnect failed");
        }
      }
      detachSocket();
      try {
        sock?.end(undefined);
      } catch {
        /* ignore */
      }
      sock = null;
      setStatus("disconnected", { reconnect: "none" });
    },
    closeAuth() {
      auth?.close();
    },
    dispose() {
      auth?.close();
      detachSocket();
      try {
        sock?.end(undefined);
      } catch {
        /* ignore */
      }
      sock = null;
      listeners.clear();
    },
    async sendText(jid, text) {
      if (!sock || status !== "connected") {
        throw new Error("SESSION_NOT_CONNECTED");
      }
      const normalized = jid.includes("@") ? jid : `${jid.replace(/\D/g, "")}@s.whatsapp.net`;
      const result = await sock.sendMessage(normalized, { text });
      const messageId = result?.key?.id;
      if (!messageId) throw new Error("SEND_FAILED");
      return { messageId, remoteJid: normalized };
    },
    getStatus() {
      return status;
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set<AnyListener>();
      set.add(listener as AnyListener);
      listeners.set(event, set);
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener as AnyListener);
    },
  };

  return client;
}
