import { describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "@waapi/shared";
import type { WAClient, WAClientEvents } from "../baileys/types.js";
import { SessionMetrics } from "../metrics.js";
import { SessionManager } from "./manager.js";

function mockClient(sessionId: string, accountId: string) {
  const listeners: Partial<Record<keyof WAClientEvents, Set<(...args: never[]) => void>>> = {};
  let status: SessionStatus = "connecting";
  let authClosed = false;
  let flushCalls = 0;
  const client: WAClient & {
    emit: <K extends keyof WAClientEvents>(
      event: K,
      ...args: Parameters<WAClientEvents[K]>
    ) => void;
    authClosed: () => boolean;
    flushCalls: () => number;
  } = {
    sessionId,
    accountId,
    async connect() {
      status = "connected";
    },
    async flushAuth() {
      flushCalls += 1;
    },
    async disconnect(opts?: { flush?: boolean }) {
      if (opts?.flush !== false) {
        await client.flushAuth();
      }
      status = "disconnected";
    },
    closeAuth() {
      authClosed = true;
    },
    dispose() {
      listeners.qr?.clear();
      listeners.status?.clear();
      listeners.messageMeta?.clear();
      listeners.loggedOut?.clear();
    },
    async sendText() {
      return { messageId: "m1", remoteJid: "1@s.whatsapp.net" };
    },
    getStatus() {
      return status;
    },
    on(event, listener) {
      if (!listeners[event]) listeners[event] = new Set();
      listeners[event]!.add(listener as never);
    },
    off(event, listener) {
      listeners[event]?.delete(listener as never);
    },
    emit(event, ...args) {
      for (const fn of listeners[event] ?? []) {
        (fn as (...a: unknown[]) => void)(...args);
      }
    },
    authClosed: () => authClosed,
    flushCalls: () => flushCalls,
  };
  return client;
}

function drizzleStub(session: {
  id: string;
  accountId: string;
  status: SessionStatus;
}) {
  let currentStatus = session.status;
  const statusOrder: SessionStatus[] = [];
  return {
    statusOrder,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ ...session, status: currentStatus }],
        }),
      }),
    }),
    delete: () => ({
      where: async () => undefined,
    }),
    update: () => ({
      set: (patch: { status?: SessionStatus }) => ({
        where: () => ({
          returning: async () => {
            if (currentStatus === "logged_out") return [];
            if (patch.status) {
              currentStatus = patch.status;
              statusOrder.push(patch.status);
            }
            return [{ ...session, status: currentStatus }];
          },
        }),
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        delete: () => ({ where: async () => undefined }),
        update: () => ({
          set: (patch: { status?: SessionStatus }) => ({
            where: () => ({
              returning: async () => {
                if (patch.status) currentStatus = patch.status;
                return [{ ...session, status: currentStatus }];
              },
            }),
          }),
        }),
      }),
  };
}

function redisStub() {
  const store = new Map<string, string>();
  return {
    publish: vi.fn(async () => 1),
    set: vi.fn(async (key: string, value: string, _m: string, _t: number, nx?: string) => {
      if (nx === "NX" && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    eval: vi.fn(async (_s: string, _n: number, key: string, workerId: string) => {
      if (store.get(key) === workerId) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  };
}

const baseCfg = {
  maxSessionsPerNode: 10,
  workerId: "worker-test",
  sessionLeaseTtlMs: 30_000,
  bootConnectStaggerMs: 0,
};

describe("SessionManager", () => {
  it("flushes auth on disconnect before releasing lease during shutdown", async () => {
    const accountId = "00000000-0000-4000-8000-0000000000aa";
    const sessionId = "00000000-0000-4000-8000-0000000000bb";
    const client = mockClient(sessionId, accountId);
    const redis = redisStub();
    let flushBeforeRelease = false;
    const origEval = redis.eval.bind(redis);
    redis.eval = vi.fn(async (script: string, n: number, key: string, workerId: string) => {
      flushBeforeRelease = client.flushCalls() > 0;
      return origEval(script, n, key, workerId);
    });

    const manager = new SessionManager(
      drizzleStub({ id: sessionId, accountId, status: "need_scan" }) as never,
      redis as never,
      baseCfg as never,
      { info: vi.fn(), error: vi.fn() } as never,
      async () => client,
      new SessionMetrics(),
    );

    await manager.openSession(accountId, sessionId);
    await manager.shutdown();
    expect(client.flushCalls()).toBeGreaterThan(0);
    expect(flushBeforeRelease).toBe(true);
  });

  it("closes auth before wipe on loggedOut and never schedules reconnect", async () => {
    const accountId = "00000000-0000-4000-8000-0000000000cc";
    const sessionId = "00000000-0000-4000-8000-0000000000dd";
    const client = mockClient(sessionId, accountId);
    const log = { info: vi.fn(), error: vi.fn() };

    const manager = new SessionManager(
      drizzleStub({ id: sessionId, accountId, status: "connected" }) as never,
      redisStub() as never,
      baseCfg as never,
      log as never,
      async () => client,
      new SessionMetrics(),
    );

    await manager.openSession(accountId, sessionId);
    client.emit("loggedOut");
    await vi.waitFor(() => expect(manager.liveCount()).toBe(0));
    expect(client.authClosed()).toBe(true);
    expect(log.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId }),
      "scheduling reconnect",
    );
    await expect(manager.openSession(accountId, sessionId)).rejects.toThrow("SESSION_LOGGED_OUT");
  });

  it("serializes rapid connected -> disconnected status writes in order", async () => {
    const accountId = "00000000-0000-4000-8000-0000000000ee";
    const sessionId = "00000000-0000-4000-8000-0000000000ff";
    const client = mockClient(sessionId, accountId);
    const stub = drizzleStub({ id: sessionId, accountId, status: "connecting" });

    const manager = new SessionManager(
      stub as never,
      redisStub() as never,
      baseCfg as never,
      { info: vi.fn(), error: vi.fn() } as never,
      async () => client,
      new SessionMetrics(),
    );

    await manager.openSession(accountId, sessionId);
    client.emit("status", "connected");
    client.emit("status", "disconnected", { reconnect: "none" });
    await vi.waitFor(() => {
      expect(stub.statusOrder).toEqual(["connected", "disconnected"]);
    });
  });

  it("schedules reconnect on boot for transient SESSION_LEASE_HELD", async () => {
    vi.useFakeTimers();
    const accountId = "00000000-0000-4000-8000-000000000011";
    const sessionId = "00000000-0000-4000-8000-000000000022";
    const log = { info: vi.fn(), error: vi.fn() };
    const redis = redisStub();
    // Pre-hold lease as another worker
    await redis.set(`waapi:lease:${sessionId}`, "other-worker", "PX", 30_000, "NX");

    const row = { id: sessionId, accountId, status: "connected" as const };
    const whereBuilder = () => {
      const rows = [row];
      const builder = Promise.resolve(rows) as Promise<typeof rows> & {
        limit: () => Promise<typeof rows>;
        orderBy: () => { limit: () => Promise<typeof rows> };
      };
      builder.limit = async () => rows;
      builder.orderBy = () => ({ limit: async () => rows });
      return builder;
    };

    const manager = new SessionManager(
      {
        select: () => ({
          from: () => ({
            where: whereBuilder,
          }),
        }),
        delete: () => ({ where: async () => undefined }),
        update: () => ({
          set: () => ({
            where: () => ({
              returning: async () => [row],
            }),
          }),
        }),
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
      } as never,
      redis as never,
      baseCfg as never,
      log as never,
      async () => mockClient(sessionId, accountId),
      new SessionMetrics(),
    );

    await manager.loadOnBoot();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId }),
      "failed to load session on boot",
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId }),
      "scheduling reconnect",
    );
    vi.useRealTimers();
  });

  it("uses disposeClient on openSession failure (half-open cleanup)", async () => {
    const accountId = "00000000-0000-4000-8000-000000000033";
    const sessionId = "00000000-0000-4000-8000-000000000044";
    const client = mockClient(sessionId, accountId);
    const dispose = vi.spyOn(client, "dispose");
    const disconnect = vi.spyOn(client, "disconnect");

    const manager = new SessionManager(
      drizzleStub({ id: sessionId, accountId, status: "need_scan" }) as never,
      redisStub() as never,
      baseCfg as never,
      { info: vi.fn(), error: vi.fn() } as never,
      async () => {
        const c = client;
        c.connect = async () => {
          throw new Error("CONNECT_FAIL");
        };
        return c;
      },
      new SessionMetrics(),
    );

    await expect(manager.openSession(accountId, sessionId)).rejects.toThrow("CONNECT_FAIL");
    expect(disconnect).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    expect(manager.liveCount()).toBe(0);
  });
});
