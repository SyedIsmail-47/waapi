import { describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "@waapi/shared";
import type { WAClient, WAClientEvents } from "../baileys/types.js";
import { SessionMetrics } from "../metrics.js";
import { SessionManager } from "./manager.js";

function mockClient(sessionId: string, accountId: string) {
  const listeners: Partial<Record<keyof WAClientEvents, Set<(...args: never[]) => void>>> = {};
  let status: SessionStatus = "connecting";
  const client: WAClient & {
    emit: <K extends keyof WAClientEvents>(
      event: K,
      ...args: Parameters<WAClientEvents[K]>
    ) => void;
  } = {
    sessionId,
    accountId,
    async connect() {
      status = "connected";
    },
    async disconnect() {
      status = "disconnected";
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
  };
  return client;
}

function drizzleStub(session: {
  id: string;
  accountId: string;
  status: SessionStatus;
}) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [session],
        }),
      }),
    }),
    delete: () => ({
      where: async () => undefined,
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => [{ ...session, status: "logged_out" }],
        }),
      }),
    }),
  };
}

describe("SessionManager", () => {
  it("closes all clients on shutdown", async () => {
    const accountId = "00000000-0000-4000-8000-0000000000aa";
    const sessionId = "00000000-0000-4000-8000-0000000000bb";
    const client = mockClient(sessionId, accountId);
    const disconnect = vi.spyOn(client, "disconnect");

    const manager = new SessionManager(
      drizzleStub({ id: sessionId, accountId, status: "need_scan" }) as never,
      { publish: vi.fn(async () => 1) } as never,
      { maxSessionsPerNode: 10 } as never,
      { info: vi.fn(), error: vi.fn() } as never,
      async () => client,
      new SessionMetrics(),
    );

    await manager.openSession(accountId, sessionId);
    expect(manager.liveCount()).toBe(1);
    await manager.shutdown();
    expect(disconnect).toHaveBeenCalled();
    expect(manager.liveCount()).toBe(0);
  });

  it("removes client after loggedOut", async () => {
    const accountId = "00000000-0000-4000-8000-0000000000cc";
    const sessionId = "00000000-0000-4000-8000-0000000000dd";
    const client = mockClient(sessionId, accountId);

    const manager = new SessionManager(
      drizzleStub({ id: sessionId, accountId, status: "connected" }) as never,
      { publish: vi.fn(async () => 1) } as never,
      { maxSessionsPerNode: 10 } as never,
      { info: vi.fn(), error: vi.fn() } as never,
      async () => client,
      new SessionMetrics(),
    );

    await manager.openSession(accountId, sessionId);
    client.emit("loggedOut");
    await new Promise((r) => setTimeout(r, 30));
    expect(manager.liveCount()).toBe(0);
  });
});
