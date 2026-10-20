import type { SessionStatus } from "@waapi/shared";
import type { WorkerConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { insertMessageLog } from "../db/message-logs.js";
import { eq } from "drizzle-orm";
import { sessions } from "@waapi/db";
import { QR_TTL_SECONDS } from "@waapi/shared";
import {
  createSessionTransactional,
  getSessionForAccount,
  listSessionsToLoad,
  markLoggedOutAndWipeAuth,
  sweepAuthForLoggedOutSessions,
  updateSessionStatus,
} from "../db/sessions.js";
import { enqueueWebhookOutbox } from "../db/webhook-outbox.js";
import type { Logger } from "../logger.js";
import { publishQr, publishStatus } from "../redis/pubsub.js";
import { SessionLeaseManager } from "../redis/lease.js";
import type { Redis } from "ioredis";
import type { StatusDetail, WAClient, WAClientFactory } from "../baileys/types.js";
import { nextBackoffMs } from "./reconnect.js";
import { isNonRetryableOpenError } from "./disconnect-reason.js";
import { SessionMetrics } from "../metrics.js";

const IMMEDIATE_RECONNECT_WINDOW_MS = 30_000;
const IMMEDIATE_RECONNECT_MAX = 3;
/** Overall cap for parallel session dispose during shutdown (under docker stop_grace_period 30s). */
const SHUTDOWN_DISPOSE_CAP_MS = 25_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class SessionManager {
  private readonly clients = new Map<string, WAClient>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly loggedOutSessions = new Set<string>();
  private readonly statusQueues = new Map<string, Promise<void>>();
  private readonly immediateReconnectAt = new Map<string, number[]>();
  private readonly leases: SessionLeaseManager;
  private shuttingDown = false;

  constructor(
    private readonly db: Db["db"],
    private readonly redis: Redis,
    private readonly cfg: WorkerConfig,
    private readonly log: Logger,
    private readonly createClient: WAClientFactory,
    private readonly metrics: SessionMetrics,
  ) {
    this.leases = new SessionLeaseManager(redis, cfg.workerId, cfg.sessionLeaseTtlMs);
    this.leases.setRenewalFailedHandler((sessionId) => {
      void this.handleLeaseRenewalFailed(sessionId).catch((err) => {
        this.log.error({ err, sessionId }, "lease renewal failure handler failed");
      });
    });
  }

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
    if (this.loggedOutSessions.has(sessionId)) throw new Error("SESSION_LOGGED_OUT");
    if (this.clients.has(sessionId)) return;
    if (this.clients.size >= this.cfg.maxSessionsPerNode) {
      await this.db
        .update(sessions)
        .set({
          status: "error",
          lastError: "NODE_SESSION_CAP",
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, sessionId));
      throw new Error("NODE_SESSION_CAP");
    }

    const session = await getSessionForAccount(this.db, accountId, sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND_FOR_ACCOUNT");
    if (session.status === "logged_out") {
      this.loggedOutSessions.add(sessionId);
      throw new Error("SESSION_LOGGED_OUT");
    }

    const leased = await this.leases.tryAcquire(sessionId);
    if (!leased) throw new Error("SESSION_LEASE_HELD");

    try {
      await this.db
        .update(sessions)
        .set({ nodeId: this.cfg.workerId, updatedAt: new Date() })
        .where(eq(sessions.id, sessionId));
      const client = await this.createClient({ sessionId, accountId });
      this.bindClient(client);
      this.clients.set(sessionId, client);
      this.metrics.setLiveSessions(this.clients.size);
      await client.connect();
    } catch (err) {
      const existing = this.clients.get(sessionId);
      if (existing) {
        await this.disposeClient(existing);
      } else {
        await this.leases.release(sessionId);
      }
      throw err;
    }
  }

  async closeSession(accountId: string, sessionId: string): Promise<void> {
    const session = await getSessionForAccount(this.db, accountId, sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND_FOR_ACCOUNT");
    this.clearReconnect(sessionId);
    const client = this.clients.get(sessionId);
    if (client) {
      await this.disposeClient(client, { flush: true });
    }
    await updateSessionStatus(this.db, accountId, sessionId, "disconnected", {
      lastError: null,
    });
  }

  async logoutSession(accountId: string, sessionId: string): Promise<void> {
    const session = await getSessionForAccount(this.db, accountId, sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND_FOR_ACCOUNT");
    const client = this.clients.get(sessionId);
    if (client) {
      await this.handleLoggedOut(client);
      return;
    }
    this.loggedOutSessions.add(sessionId);
    this.clearReconnect(sessionId);
    await markLoggedOutAndWipeAuth(this.db, accountId, sessionId);
  }

  private isCurrentClient(client: WAClient): boolean {
    return this.clients.get(client.sessionId) === client;
  }

  /** Serialize per-session status/logout work so DB writes follow event order. */
  private enqueueSessionWork(sessionId: string, work: () => Promise<void>): Promise<void> {
    const prev = this.statusQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(work, work);
    this.statusQueues.set(sessionId, next);
    return next;
  }

  private bindClient(client: WAClient): void {
    client.on("qr", (qr) => {
      if (!this.isCurrentClient(client)) return;
      void this.persistQr(client, qr).catch((err) => {
        this.log.error({ err, sessionId: client.sessionId }, "publishQr failed");
      });
    });

    client.on("status", (status, detail) => {
      if (!this.isCurrentClient(client)) return;
      void this.enqueueSessionWork(client.sessionId, () =>
        this.handleStatus(client, status, detail),
      ).catch((err) => {
        this.log.error({ err, sessionId: client.sessionId }, "handleStatus failed");
      });
    });

    client.on("messageMeta", (meta) => {
      if (!this.isCurrentClient(client)) return;
      void (async () => {
        await insertMessageLog(this.db, {
          accountId: client.accountId,
          sessionId: client.sessionId,
          direction: meta.fromMe ? "outbound" : "inbound",
          remoteJid: meta.remoteJid,
          messageId: meta.messageId,
          fromMe: meta.fromMe,
          messageType: meta.messageType,
        });
        if (!meta.fromMe) {
          await enqueueWebhookOutbox(this.db, {
            accountId: client.accountId,
            sessionId: client.sessionId,
            eventType: "messages.upsert",
            payload: {
              id: crypto.randomUUID(),
              type: "messages.upsert",
              accountId: client.accountId,
              sessionId: client.sessionId,
              createdAt: new Date().toISOString(),
              data: {
                remoteJid: meta.remoteJid,
                messageId: meta.messageId,
                fromMe: meta.fromMe,
                messageType: meta.messageType,
              },
            },
          });
        }
      })().catch((err) => {
        this.log.error({ err, sessionId: client.sessionId }, "message log insert failed");
      });
    });

    client.on("loggedOut", () => {
      if (!this.isCurrentClient(client)) return;
      void this.enqueueSessionWork(client.sessionId, () => this.handleLoggedOut(client)).catch(
        (err) => {
          this.log.error({ err, sessionId: client.sessionId }, "handleLoggedOut failed");
        },
      );
    });
  }

  private async handleLeaseRenewalFailed(sessionId: string): Promise<void> {
    const client = this.clients.get(sessionId);
    if (!client) return;
    this.log.error({ sessionId }, "lease renewal failed; stopping session");
    await updateSessionStatus(this.db, client.accountId, sessionId, "disconnected", {
      lastError: "lease_renewal_failed",
    });
    await publishStatus(this.redis, {
      sessionId,
      accountId: client.accountId,
      status: "disconnected",
      at: new Date().toISOString(),
      lastError: "lease_renewal_failed",
    }).catch((err) => {
      this.log.error({ err, sessionId }, "publishStatus failed");
    });
    await this.disposeClient(client);
  }

  private allowImmediateReconnect(sessionId: string): boolean {
    const now = Date.now();
    const recent = (this.immediateReconnectAt.get(sessionId) ?? []).filter(
      (t) => now - t < IMMEDIATE_RECONNECT_WINDOW_MS,
    );
    if (recent.length >= IMMEDIATE_RECONNECT_MAX) {
      this.immediateReconnectAt.set(sessionId, recent);
      return false;
    }
    recent.push(now);
    this.immediateReconnectAt.set(sessionId, recent);
    return true;
  }

  private async persistQr(client: WAClient, qr: string): Promise<void> {
    const at = new Date();
    const expiresAt = new Date(at.getTime() + QR_TTL_SECONDS * 1000);
    await this.db
      .update(sessions)
      .set({
        status: "need_scan",
        updatedAt: at,
      })
      .where(eq(sessions.id, client.sessionId));
    await publishQr(this.redis, {
      sessionId: client.sessionId,
      qr,
      at: at.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    await enqueueWebhookOutbox(this.db, {
      accountId: client.accountId,
      sessionId: client.sessionId,
      eventType: "qrcode.updated",
      payload: {
        id: crypto.randomUUID(),
        type: "qrcode.updated",
        accountId: client.accountId,
        sessionId: client.sessionId,
        createdAt: at.toISOString(),
        data: { updatedAt: at.toISOString(), expiresAt: expiresAt.toISOString() },
      },
    });
  }

  private async handleStatus(
    client: WAClient,
    status: SessionStatus,
    detail?: StatusDetail,
  ): Promise<void> {
    if (!this.isCurrentClient(client)) return;
    if (this.loggedOutSessions.has(client.sessionId)) return;

    this.metrics.observeStatus(status);
    const updated = await updateSessionStatus(this.db, client.accountId, client.sessionId, status, {
      lastError: detail?.error ?? null,
      phoneNumber: detail?.phoneNumber,
    });
    if (!updated) return;

    const at = new Date().toISOString();
    await publishStatus(this.redis, {
      sessionId: client.sessionId,
      accountId: client.accountId,
      status,
      at,
      lastError: detail?.error ?? null,
    }).catch((err) => {
      this.log.error({ err, sessionId: client.sessionId }, "publishStatus failed");
    });

    await enqueueWebhookOutbox(this.db, {
      accountId: client.accountId,
      sessionId: client.sessionId,
      eventType: "session.status",
      payload: {
        id: crypto.randomUUID(),
        type: "session.status",
        accountId: client.accountId,
        sessionId: client.sessionId,
        createdAt: at,
        data: { status, lastError: detail?.error ?? null, phoneNumber: detail?.phoneNumber ?? null },
      },
    }).catch((err) => {
      this.log.error({ err, sessionId: client.sessionId }, "webhook outbox failed");
    });

    if (status === "connected") {
      this.reconnectAttempts.set(client.sessionId, 0);
      this.clearReconnect(client.sessionId);
      return;
    }

    if (detail?.reconnect === "none" || this.shuttingDown) {
      if (status === "error") {
        await this.disposeClient(client);
      }
      return;
    }

    if (status === "disconnected" || status === "error") {
      if (detail?.reconnect === "immediate") {
        if (this.allowImmediateReconnect(client.sessionId)) {
          this.clearReconnect(client.sessionId);
          void this.reconnectNow(client.accountId, client.sessionId).catch((err) => {
            this.log.error({ err, sessionId: client.sessionId }, "immediate reconnect failed");
            if (!isNonRetryableOpenError(err)) {
              this.scheduleReconnect(client.accountId, client.sessionId);
            }
          });
          return;
        }
        this.log.info(
          { sessionId: client.sessionId },
          "immediate reconnect cap exceeded; using backoff",
        );
      }
      this.scheduleReconnect(client.accountId, client.sessionId);
    }
  }

  private async reconnectNow(accountId: string, sessionId: string): Promise<void> {
    if (this.shuttingDown || this.loggedOutSessions.has(sessionId)) return;
    const existing = this.clients.get(sessionId);
    if (existing) {
      await this.disposeClient(existing);
    }
    await this.openSession(accountId, sessionId);
  }

  private scheduleReconnect(accountId: string, sessionId: string): void {
    if (this.shuttingDown || this.loggedOutSessions.has(sessionId)) return;
    this.clearReconnect(sessionId);
    const attempt = (this.reconnectAttempts.get(sessionId) ?? 0) + 1;
    this.reconnectAttempts.set(sessionId, attempt);
    const delay = nextBackoffMs({ attempt });
    this.log.info({ sessionId, attempt, delay }, "scheduling reconnect");
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(sessionId);
      void (async () => {
        if (this.loggedOutSessions.has(sessionId) || this.shuttingDown) return;
        try {
          const existing = this.clients.get(sessionId);
          if (existing) {
            await this.disposeClient(existing);
          }
          await this.openSession(accountId, sessionId);
        } catch (err) {
          this.log.error({ err, sessionId }, "reconnect failed");
          if (isNonRetryableOpenError(err)) {
            this.clearReconnect(sessionId);
            return;
          }
          this.scheduleReconnect(accountId, sessionId);
        }
      })().catch((err) => {
        this.log.error({ err, sessionId }, "reconnect task failed");
      });
    }, delay);
    this.reconnectTimers.set(sessionId, timer);
  }

  private clearReconnect(sessionId: string): void {
    const t = this.reconnectTimers.get(sessionId);
    if (t) clearTimeout(t);
    this.reconnectTimers.delete(sessionId);
  }

  /**
   * Dispose order:
   * - Normal shutdown: disconnect({ flush: true }) → dispose → release lease
   * - Logout: closeAuth → wipe (already done) → disconnect({ flush: false }) → dispose → release
   */
  private async disposeClient(
    client: WAClient,
    opts: { flush?: boolean } = { flush: true },
  ): Promise<void> {
    if (this.clients.get(client.sessionId) === client) {
      this.clients.delete(client.sessionId);
    }
    try {
      await client.disconnect({ flush: opts.flush !== false });
    } catch {
      /* ignore */
    }
    client.dispose();
    await this.leases.release(client.sessionId);
    this.metrics.setLiveSessions(this.clients.size);
  }

  private async handleLoggedOut(client: WAClient): Promise<void> {
    if (!this.isCurrentClient(client)) return;

    this.loggedOutSessions.add(client.sessionId);
    this.clearReconnect(client.sessionId);

    // Logout order: close → wipe (no flush), then dispose without flush.
    client.closeAuth();

    await markLoggedOutAndWipeAuth(this.db, client.accountId, client.sessionId);

    await publishStatus(this.redis, {
      sessionId: client.sessionId,
      accountId: client.accountId,
      status: "logged_out",
      at: new Date().toISOString(),
    }).catch((err) => {
      this.log.error({ err, sessionId: client.sessionId }, "publishStatus failed");
    });

    await this.disposeClient(client, { flush: false });
  }

  async loadOnBoot(): Promise<void> {
    const swept = await sweepAuthForLoggedOutSessions(this.db);
    if (swept > 0) {
      this.log.info({ swept }, "swept auth rows for logged_out sessions");
    }

    const rows = await listSessionsToLoad(this.db, this.cfg.maxSessionsPerNode);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (i > 0 && this.cfg.bootConnectStaggerMs > 0) {
        await sleep(this.cfg.bootConnectStaggerMs);
      }
      try {
        await this.openSession(row.accountId, row.id);
      } catch (err) {
        this.log.error({ err, sessionId: row.id }, "failed to load session on boot");
        // Transient: lease held, DB/Redis blip — schedule reconnect instead of only logging.
        if (!isNonRetryableOpenError(err)) {
          this.scheduleReconnect(row.accountId, row.id);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const sessionId of [...this.reconnectTimers.keys()]) {
      this.clearReconnect(sessionId);
    }
    const clients = [...this.clients.values()];
    const closes = Promise.all(
      clients.map(async (c) => {
        try {
          // Normal shutdown: flush → close (disconnect flushes, then dispose).
          await this.disposeClient(c, { flush: true });
        } catch {
          /* ignore */
        }
      }),
    );
    let timedOut = false;
    await Promise.race([
      closes,
      sleep(SHUTDOWN_DISPOSE_CAP_MS).then(() => {
        timedOut = true;
      }),
    ]);
    if (timedOut) {
      this.log.warn(
        { capMs: SHUTDOWN_DISPOSE_CAP_MS, live: this.clients.size },
        "shutdown dispose cap reached; releasing leases",
      );
    }
    this.clients.clear();
    await this.leases.releaseAll();
    this.metrics.setLiveSessions(0);
  }
}
