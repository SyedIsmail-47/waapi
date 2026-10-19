import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Redis } from "ioredis";
import { SessionLeaseManager, leaseKey } from "./lease.js";

function mockRedisStore() {
  const store = new Map<string, string>();
  return {
    store,
    redis: {
      set: vi.fn(async (key: string, value: string, _mode: string, _ttl: number, nx?: string) => {
        if (nx === "NX" && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      eval: vi.fn(async (script: string, _n: number, key: string, workerId: string, _ttl?: string) => {
        if (script.includes("pexpire")) {
          if (store.get(key) === workerId) {
            return 1;
          }
          return 0;
        }
        if (store.get(key) === workerId) {
          store.delete(key);
          return 1;
        }
        return 0;
      }),
    },
  };
}

describe("SessionLeaseManager", () => {
  it("acquires with SET NX PX and refuses second owner", async () => {
    const { redis } = mockRedisStore();
    const a = new SessionLeaseManager(redis as never, "worker-a", 30_000);
    const b = new SessionLeaseManager(redis as never, "worker-b", 30_000);
    expect(await a.tryAcquire("sess-1")).toBe(true);
    expect(await b.tryAcquire("sess-1")).toBe(false);
    expect(leaseKey("sess-1")).toBe("waapi:lease:sess-1");
    await a.release("sess-1");
    expect(await b.tryAcquire("sess-1")).toBe(true);
    await b.release("sess-1");
  });

  it("reclaims stale lease with same workerId (kill -9 recovery)", async () => {
    const { store, redis } = mockRedisStore();
    store.set(leaseKey("sess-crash"), "worker-stable");
    const manager = new SessionLeaseManager(redis as never, "worker-stable", 30_000);
    expect(await manager.tryAcquire("sess-crash")).toBe(true);
    await manager.release("sess-crash");
  });

  it("release is compare-and-delete (other worker cannot steal release)", async () => {
    const { store, redis } = mockRedisStore();
    const a = new SessionLeaseManager(redis as never, "worker-a", 30_000);
    expect(await a.tryAcquire("sess-1")).toBe(true);
    const b = new SessionLeaseManager(redis as never, "worker-b", 30_000);
    await b.release("sess-1");
    expect(store.has(leaseKey("sess-1"))).toBe(true);
    await a.release("sess-1");
    expect(store.has(leaseKey("sess-1"))).toBe(false);
  });

  it("stops session when Lua renew returns 0 (ownership lost)", async () => {
    vi.useFakeTimers();
    const { redis } = mockRedisStore();
    redis.eval = vi.fn(async () => 0);
    const failed = vi.fn();
    const manager = new SessionLeaseManager(redis as never, "worker-a", 3_000);
    manager.setRenewalFailedHandler(failed);
    redis.set = vi.fn(async () => "OK");
    expect(await manager.tryAcquire("sess-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(manager.renewalIntervalMs());
    await Promise.resolve();
    await Promise.resolve();
    expect(failed).toHaveBeenCalledWith("sess-1");
    vi.useRealTimers();
  });

  it("keeps session up after 2 Redis blips then a successful renew", async () => {
    vi.useFakeTimers();
    const { redis } = mockRedisStore();
    // ttl 10s → interval ~3333 → maxBlip ~6667; two throws stay under threshold
    const manager = new SessionLeaseManager(redis as never, "worker-a", 10_000);
    const failed = vi.fn();
    manager.setRenewalFailedHandler(failed);
    redis.set = vi.fn(async () => "OK");

    let renewCalls = 0;
    redis.eval = vi.fn(async (script: string) => {
      if (!script.includes("pexpire")) return 1;
      renewCalls += 1;
      if (renewCalls <= 2) throw new Error("REDIS_BLIP");
      return 1;
    });

    expect(await manager.tryAcquire("sess-1")).toBe(true);
    const interval = manager.renewalIntervalMs();
    await vi.advanceTimersByTimeAsync(interval);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(interval);
    await Promise.resolve();
    await Promise.resolve();
    expect(failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(interval);
    await Promise.resolve();
    await Promise.resolve();
    expect(failed).not.toHaveBeenCalled();
    expect(renewCalls).toBeGreaterThanOrEqual(3);
    await manager.release("sess-1");
    vi.useRealTimers();
  });

  it("releaseAll releases held leases tracked in Set even without timers", async () => {
    const { store, redis } = mockRedisStore();
    const manager = new SessionLeaseManager(redis as never, "worker-a", 30_000);
    expect(await manager.tryAcquire("sess-1")).toBe(true);
    expect(await manager.tryAcquire("sess-2")).toBe(true);
    // Stop renewal timers without clearing held set by releasing via releaseAll
    await manager.releaseAll();
    expect(store.has(leaseKey("sess-1"))).toBe(false);
    expect(store.has(leaseKey("sess-2"))).toBe(false);
  });
});

describe("SessionLeaseManager real Redis", () => {
  let redis: Redis | null = null;
  let enabled = false;

  beforeAll(async () => {
    if (!process.env.REDIS_URL) {
      if (process.env.CI) throw new Error("REDIS_URL required in CI");
      return;
    }
    try {
      redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
      await redis.connect();
      await redis.ping();
      enabled = true;
    } catch {
      if (process.env.CI) throw new Error("Redis must be reachable in CI");
      enabled = false;
    }
  });

  afterAll(async () => {
    if (redis) await redis.quit();
  });

  it("hits real Redis for reclaim after simulated kill -9", async () => {
    if (!enabled || !redis) return;
    const sessionId = `lease-test-${Date.now()}`;
    const workerId = "ci-worker-stable";
    await redis.set(leaseKey(sessionId), workerId, "PX", 60_000);
    const manager = new SessionLeaseManager(redis, workerId, 30_000);
    expect(await manager.tryAcquire(sessionId)).toBe(true);
    await manager.release(sessionId);
    expect(await redis.get(leaseKey(sessionId))).toBeNull();
  });
});
