import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

const RENEW_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export function nodeLockKey(workerId: string): string {
  return `waapi:node:${workerId}`;
}

/**
 * Node-level lock so two live processes cannot share the same WORKER_ID.
 * Value is a random bootId; renewed while the process is alive.
 * After a crash the key expires with its TTL — wait up to that TTL before
 * the same WORKER_ID can start again (or use a unique WORKER_ID).
 */
export class NodeLock {
  readonly bootId: string;
  private renewTimer: NodeJS.Timeout | null = null;
  private held = false;

  constructor(
    private readonly redis: Redis,
    private readonly workerId: string,
    private readonly ttlMs: number,
    bootId: string = randomUUID(),
  ) {
    this.bootId = bootId;
  }

  get key(): string {
    return nodeLockKey(this.workerId);
  }

  /**
   * Acquire exclusive node lock. Throws NODE_LOCK_HELD if another live bootId owns it.
   * Stale crash locks expire after ttlMs (documented max wait).
   */
  async acquire(): Promise<void> {
    const ok = await this.redis.set(this.key, this.bootId, "PX", this.ttlMs, "NX");
    if (ok === "OK") {
      this.held = true;
      this.startRenewal();
      return;
    }
    const current = await this.redis.get(this.key);
    if (current === this.bootId) {
      const renewed = await this.renew();
      if (renewed) {
        this.held = true;
        this.startRenewal();
        return;
      }
    }
    const waitSec = Math.ceil(this.ttlMs / 1000);
    throw new Error(
      `NODE_LOCK_HELD: another live worker already holds WORKER_ID=${this.workerId}` +
        ` (bootId=${current ?? "unknown"}). ` +
        `If that process crashed, wait up to ${waitSec}s for the lock TTL to expire, ` +
        `or set a unique WORKER_ID.`,
    );
  }

  async renew(): Promise<boolean> {
    const result = await this.redis.eval(
      RENEW_LUA,
      1,
      this.key,
      this.bootId,
      String(this.ttlMs),
    );
    return Number(result) === 1;
  }

  async release(): Promise<void> {
    this.stopRenewal();
    if (!this.held) return;
    await this.redis.eval(RELEASE_LUA, 1, this.key, this.bootId);
    this.held = false;
  }

  private startRenewal(): void {
    this.stopRenewal();
    const interval = Math.max(1_000, Math.floor(this.ttlMs / 3));
    this.renewTimer = setInterval(() => {
      void this.renew().then((ok) => {
        if (!ok) this.stopRenewal();
      });
    }, interval);
    this.renewTimer.unref?.();
  }

  private stopRenewal(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
  }
}
