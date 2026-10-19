import type { Redis } from "ioredis";

const RENEW_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

/** Atomic compare-and-delete: only the owner may release. */
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export function leaseKey(sessionId: string): string {
  return `waapi:lease:${sessionId}`;
}

export type LeaseRenewalFailedHandler = (sessionId: string) => void;

export class SessionLeaseManager {
  private readonly renewTimers = new Map<string, NodeJS.Timeout>();
  /** Every session lease we currently hold (not just those with timers). */
  private readonly held = new Set<string>();
  private readonly lastSuccessfulRenewAt = new Map<string, number>();
  private onRenewalFailed: LeaseRenewalFailedHandler | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly workerId: string,
    private readonly ttlMs: number,
  ) {}

  setRenewalFailedHandler(handler: LeaseRenewalFailedHandler | null): void {
    this.onRenewalFailed = handler;
  }

  renewalIntervalMs(): number {
    return Math.max(1_000, Math.floor(this.ttlMs / 3));
  }

  /** Stop session only after no successful renew for this long (ttl − one interval). */
  maxRenewalBlipMs(): number {
    return Math.max(0, this.ttlMs - this.renewalIntervalMs());
  }

  /**
   * Acquire with SET NX PX. If the key already holds our own workerId
   * (stale lease after kill -9 / restart), reclaim and renew TTL.
   */
  async tryAcquire(sessionId: string): Promise<boolean> {
    const key = leaseKey(sessionId);
    const ok = await this.redis.set(key, this.workerId, "PX", this.ttlMs, "NX");
    if (ok === "OK") {
      this.held.add(sessionId);
      this.startRenewal(sessionId);
      return true;
    }
    const current = await this.redis.get(key);
    if (current === this.workerId) {
      const renewed = await this.renew(sessionId);
      if (renewed) {
        this.held.add(sessionId);
        this.startRenewal(sessionId);
        return true;
      }
    }
    return false;
  }

  async renew(sessionId: string): Promise<boolean> {
    const result = await this.redis.eval(
      RENEW_LUA,
      1,
      leaseKey(sessionId),
      this.workerId,
      String(this.ttlMs),
    );
    return Number(result) === 1;
  }

  /** Atomic compare-and-delete (Lua). */
  async release(sessionId: string): Promise<void> {
    this.stopRenewal(sessionId);
    this.held.delete(sessionId);
    this.lastSuccessfulRenewAt.delete(sessionId);
    await this.redis.eval(RELEASE_LUA, 1, leaseKey(sessionId), this.workerId);
  }

  private startRenewal(sessionId: string): void {
    this.stopRenewal(sessionId);
    const now = Date.now();
    this.lastSuccessfulRenewAt.set(sessionId, now);
    const interval = this.renewalIntervalMs();
    const maxBlip = this.maxRenewalBlipMs();

    const timer = setInterval(() => {
      void (async () => {
        try {
          const ok = await this.renew(sessionId);
          if (!ok) {
            // Lua returned 0 — ownership lost. Stop immediately.
            this.stopRenewal(sessionId);
            this.held.delete(sessionId);
            this.onRenewalFailed?.(sessionId);
            return;
          }
          this.lastSuccessfulRenewAt.set(sessionId, Date.now());
        } catch {
          // Redis blip: keep retrying each interval; stop only if stale.
          const last = this.lastSuccessfulRenewAt.get(sessionId) ?? 0;
          if (Date.now() - last >= maxBlip) {
            this.stopRenewal(sessionId);
            this.held.delete(sessionId);
            this.onRenewalFailed?.(sessionId);
          }
        }
      })();
    }, interval);
    timer.unref?.();
    this.renewTimers.set(sessionId, timer);
  }

  private stopRenewal(sessionId: string): void {
    const t = this.renewTimers.get(sessionId);
    if (t) clearInterval(t);
    this.renewTimers.delete(sessionId);
  }

  /** Release every held lease, tracked in a Set (not only those with timers). */
  async releaseAll(): Promise<void> {
    const ids = [...this.held];
    await Promise.all(ids.map((id) => this.release(id)));
  }
}
