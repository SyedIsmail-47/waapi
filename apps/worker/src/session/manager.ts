import type { SessionStatus } from "@waapi/shared";
import type { WorkerConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { insertMessageLog } from "../db/message-logs.js";
import {
  createSessionTransactional,
  getSessionForAccount,
  listSessionsToLoad,
  updateSessionStatus,
  wipeAuthForSession,
} from "../db/sessions.js";
import type { Logger } from "../logger.js";
import { publishQr, publishStatus } from "../redis/pubsub.js";
import type { Redis } from "ioredis";
import type { WAClient, WAClientFactory } from "../baileys/types.js";
import { nextBackoffMs } from "./reconnect.js";
import { SessionMetrics } from "../metrics.js";

export class SessionManager {
  private readonly clients = new Map<string, WAClient>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private shuttingDown = false;

  constructor(
    private readonly db: Db["db"],
    private readonly redis: Redis,
    private readonly cfg: WorkerConfig,
    private readonly log: Logger,
    private readonly createClient: WAClientFactory,
    private readonly metrics: SessionMetrics,
  ) {}

  liveCount(): number {
    return this.clients.size;
  }

  getClient(sessionId: string): WAClient | undefined {
    return this.clients.get(sessionId);
  }

  async createSession(accountId: string, name: string) {
    const row = await createSessionTransactional(this.db, {
      accountId,
      name,
      maxSessionsPerNode: this.cfg.maxSessionsPerNode,
      currentNodeSessionCount: this.clients.size,
    });
    await this.openSession(row.accountId, row.id);
    return row;
  }

  async openSession(accountId: string, sessionId: string): Promise<void> {
    if (this.shuttingDown) throw new Error("SHUTTING_DOWN");
    if (this.clients.has(sessionId)) return;
    if (this.clients.size >= this.cfg.maxSessionsPerNode) {
      throw new Error("NODE_SESSION_CAP");
    }

    const session = await getSessionForAccount(this.db, accountId, sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND_FOR_ACCOUNT");
    if (session.status === "logged_out") throw new Error("SESSION_LOGGED_OUT");

    const client = await this.createClient({ sessionId, accountId });
    this.bindClient(client);
    this.clients.set(sessionId, client);
    this.metrics.setLiveSessions(this.clients.size);
    await client.connect();
  }

  private bindClient(client: WAClient): void {
    client.on("qr", (qr) => {
      void publishQr(this.redis, {
        sessionId: client.sessionId,
        qr,
        at: new Date().toISOString(),
      });
    });

    client.on("status", (status, detail) => {
      void this.handleStatus(client, status, detail);
    });

    client.on("messageMeta", (meta) => {
      void insertMessageLog(this.db, {
        accountId: client.accountId,
        sessionId: client.sessionId,
        direction: meta.fromMe ? "outbound" : "inbound",
        remoteJid: meta.remoteJid,
        messageId: meta.messageId,
        fromMe: meta.fromMe,
        messageType: meta.messageType,
      }).catch((err) => {
        this.log.error({ err, sessionId: client.sessionId }, "message log insert failed");
      });
    });

    client.on("loggedOut", () => {
      void this.handleLoggedOut(client);
    });
  }

  private async handleStatus(
    client: WAClient,
    status: SessionStatus,
    detail?: { error?: string; phoneNumber?: string },
  ): Promise<void> {
    this.metrics.observeStatus(status);
    const updated = await updateSessionStatus(this.db, client.accountId, client.sessionId, status, {
      lastError: detail?.error ?? null,
      phoneNumber: detail?.phoneNumber,
    });
    if (!updated) return;

    await publishStatus(this.redis, {
      sessionId: client.sessionId,
      accountId: client.accountId,
      status,
      at: new Date().toISOString(),
      lastError: detail?.error ?? null,
    });

    if (status === "connected") {
      this.reconnectAttempts.set(client.sessionId, 0);
      this.clearReconnect(client.sessionId);
    }

    if (status === "disconnected" && !this.shuttingDown) {
      this.scheduleReconnect(client.accountId, client.sessionId);
    }
  }

  private scheduleReconnect(accountId: string, sessionId: string): void {
    this.clearReconnect(sessionId);
    const attempt = (this.reconnectAttempts.get(sessionId) ?? 0) + 1;
    this.reconnectAttempts.set(sessionId, attempt);
    const delay = nextBackoffMs({ attempt });
    this.log.info({ sessionId, attempt, delay }, "scheduling reconnect");
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const existing = this.clients.get(sessionId);
          if (existing) {
            await existing.disconnect();
            this.clients.delete(sessionId);
          }
          await this.openSession(accountId, sessionId);
        } catch (err) {
          this.log.error({ err, sessionId }, "reconnect failed");
          this.scheduleReconnect(accountId, sessionId);
        }
      })();
    }, delay);
    this.reconnectTimers.set(sessionId, timer);
  }

  private clearReconnect(sessionId: string): void {
    const t = this.reconnectTimers.get(sessionId);
    if (t) clearTimeout(t);
    this.reconnectTimers.delete(sessionId);
  }

  private async handleLoggedOut(client: WAClient): Promise<void> {
    this.clearReconnect(client.sessionId);
    await wipeAuthForSession(this.db, client.sessionId);
    await updateSessionStatus(this.db, client.accountId, client.sessionId, "logged_out", {
      lastError: null,
    });
    await publishStatus(this.redis, {
      sessionId: client.sessionId,
      accountId: client.accountId,
      status: "logged_out",
      at: new Date().toISOString(),
    });
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
    this.clients.delete(client.sessionId);
    this.metrics.setLiveSessions(this.clients.size);
  }

  async loadOnBoot(): Promise<void> {
    const rows = await listSessionsToLoad(this.db, this.cfg.maxSessionsPerNode);
    for (const row of rows) {
      try {
        await this.openSession(row.accountId, row.id);
      } catch (err) {
        this.log.error({ err, sessionId: row.id }, "failed to load session on boot");
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const sessionId of [...this.reconnectTimers.keys()]) {
      this.clearReconnect(sessionId);
    }
    const closes = [...this.clients.values()].map(async (c) => {
      try {
        await c.disconnect();
      } catch {
        /* ignore */
      }
    });
    await Promise.all(closes);
    this.clients.clear();
    this.metrics.setLiveSessions(0);
  }
}
