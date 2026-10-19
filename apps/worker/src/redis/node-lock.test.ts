import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Redis } from "ioredis";
import { NodeLock, nodeLockKey } from "./node-lock.js";

function mockRedis() {
  const store = new Map<string, string>();
  return {
    store,
    redis: {
      set: vi.fn(async (key: string, value: string, _m: string, _t: number, nx?: string) => {
        if (nx === "NX" && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      eval: vi.fn(async (script: string, _n: number, key: string, bootId: string) => {
        if (script.includes("pexpire")) {
          return store.get(key) === bootId ? 1 : 0;
        }
        if (store.get(key) === bootId) {
          store.delete(key);
          return 1;
        }
        return 0;
      }),
    },
  };
}

describe("NodeLock", () => {
  it("acquires exclusive lock and refuses a second live bootId", async () => {
    const { redis, store } = mockRedis();
    const a = new NodeLock(redis as never, "worker-1", 30_000, "boot-a");
    await a.acquire();
    expect(store.get(nodeLockKey("worker-1"))).toBe("boot-a");

    const b = new NodeLock(redis as never, "worker-1", 30_000, "boot-b");
    await expect(b.acquire()).rejects.toThrow(/NODE_LOCK_HELD/);
    await expect(b.acquire()).rejects.toThrow(/wait up to 30s/);

    await a.release();
    await b.acquire();
    expect(store.get(nodeLockKey("worker-1"))).toBe("boot-b");
    await b.release();
  });

  it("allows acquire after stale lock expires (crash TTL)", async () => {
    const { redis, store } = mockRedis();
    store.set(nodeLockKey("worker-1"), "dead-boot");
    const live = new NodeLock(redis as never, "worker-1", 30_000, "boot-new");
    await expect(live.acquire()).rejects.toThrow(/NODE_LOCK_HELD/);
    // Simulate TTL expiry
    store.delete(nodeLockKey("worker-1"));
    await live.acquire();
    expect(store.get(nodeLockKey("worker-1"))).toBe("boot-new");
    await live.release();
  });
});

describe("NodeLock real Redis", () => {
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

  it("hits real Redis for exclusive WORKER_ID lock", async () => {
    if (!enabled || !redis) return;
    const workerId = `node-lock-test-${Date.now()}`;
    const a = new NodeLock(redis, workerId, 15_000, "boot-a");
    const b = new NodeLock(redis, workerId, 15_000, "boot-b");
    await a.acquire();
    await expect(b.acquire()).rejects.toThrow(/NODE_LOCK_HELD/);
    await a.release();
    await b.acquire();
    await b.release();
  });
});
