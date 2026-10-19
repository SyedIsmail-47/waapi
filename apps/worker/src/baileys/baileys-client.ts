import makeWASocket, {
  DisconnectReason,
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
import { usePostgresAuthState } from "./auth-state.js";
import type { WAClient, WAClientEvents } from "./types.js";

type AnyListener = (...args: never[]) => void;

function messageTypeOf(msg: Record<string, unknown> | null | undefined): string {
  if (!msg) return "unknown";
  const keys = Object.keys(msg).filter((k) => k !== "messageContextInfo");
  return keys[0] ?? "unknown";
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

  const setStatus = (
    next: SessionStatus,
    detail?: { error?: string; phoneNumber?: string },
  ) => {
    status = next;
    emit("status", next, detail);
  };

  const { state, saveCreds } = await usePostgresAuthState({
    db,
    sessionId,
    accountId,
    encryptionKey: cfg.authStateEncryptionKey,
    keyVersion: cfg.authStateKeyVersion,
  });

  const connect = async (): Promise<void> => {
    closedByUs = false;
    setStatus("connecting");
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", async () => {
      await saveCreds();
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
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        if (closedByUs) {
          setStatus("disconnected");
          return;
        }
        if (loggedOut) {
          emit("loggedOut");
          setStatus("logged_out");
          return;
        }
        setStatus("disconnected", {
          error: lastDisconnect?.error?.message ?? "connection closed",
        });
      }
    });

    sock.ev.on("messages.upsert", (upsert) => {
      for (const msg of upsert.messages) {
        const remoteJid = msg.key.remoteJid;
        const messageId = msg.key.id;
        if (!remoteJid || !messageId) continue;
        const meta = {
          remoteJid,
          messageId,
          fromMe: Boolean(msg.key.fromMe),
          messageType: messageTypeOf(msg.message as Record<string, unknown> | null),
        };
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
    async disconnect() {
      closedByUs = true;
      try {
        sock?.end(undefined);
      } catch {
        /* ignore */
      }
      sock = null;
      setStatus("disconnected");
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
