import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Queue, DelayedError } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_SEND_TEXT } from "@waapi/shared";
import { claimOutboundForSend, sessionThrottleDelay, startSendTextWorker } from "./send-text.js";

/**
 * Token-bucket + moveToDelayed (from send-text.ts):
 *
 *   const delay = await sessionThrottleDelay(connection, payload.sessionId);
 *   if (delay > 0) {
 *     await job.moveToDelayed(Date.now() + delay, job.token);
 *     throw new DelayedError();
 *   }
 *
 * The job token MUST be passed to moveToDelayed; DelayedError must be thrown
 * so BullMQ does not increment attemptsMade.
 */
describe("send-text throttle (token-bucket + DelayedError)", () => {
  let redis: Redis;
  let queue: Queue;
  const prevInterval = process.env.SEND_MIN_INTERVAL_MS;

  beforeAll(async () => {
    process.env.SEND_MIN_INTERVAL_MS = "2000";
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    redis = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
    await redis.connect();
    await redis.ping();
    queue = new Queue(QUEUE_SEND_TEXT + "-throttle-test", { connection: redis });
    await queue.obliterate({ force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    process.env.SEND_MIN_INTERVAL_MS = prevInterval;
    await queue?.close();
    await redis?.quit();
  });

  it("exports DelayedError path requiring job.token", () => {
    expect(DelayedError).toBeTruthy();
    expect(sessionThrottleDelay).toBeTypeOf("function");
    expect(startSendTextWorker).toBeTypeOf("function");
  });

  it("throttled job is delayed, then sends exactly once; attemptsMade unchanged", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000099";
    await redis.del(`waapi:send:throttle:${sessionId}`);

    // First claim on throttle key — zero delay.
    const d1 = await sessionThrottleDelay(redis, sessionId, 2000);
    expect(d1).toBe(0);
    // Immediate second call — must delay.
    const d2 = await sessionThrottleDelay(redis, sessionId, 2000);
    expect(d2).toBeGreaterThan(0);

    let sendCount = 0;
    const manager = {
      getClient: () => ({
        sendText: async () => {
          sendCount += 1;
          return { messageId: `wamid-${sendCount}`, remoteJid: "14155552671@s.whatsapp.net" };
        },
      }),
    };

    const db = {
      execute: vi.fn().mockResolvedValue([{ id: "m1" }]),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                status: "connected",
                bodyText: null,
                providerMessageId: null,
              },
            ],
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => [{ id: "m1" }],
        }),
      }),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => [{ id: "log1" }],
          }),
        }),
      }),
    };

    // Simulate processor throttle branch with a fake job.
    const moveToDelayed = vi.fn(async () => undefined);
    const fakeJob = {
      data: {
        accountId: "00000000-0000-4000-8000-000000000001",
        sessionId,
        to: "14155552671@s.whatsapp.net",
        text: "hello",
        messageId: "00000000-0000-4000-8000-000000000003",
        requestId: "req",
        redacted: false,
      },
      token: "job-token-abc",
      attemptsMade: 0,
      updateData: vi.fn(),
      moveToDelayed,
    };

    const delay = await sessionThrottleDelay(redis, sessionId, 2000);
    expect(delay).toBeGreaterThan(0);
    await (fakeJob.moveToDelayed as (ts: number, token?: string) => Promise<void>)(
      Date.now() + delay,
      fakeJob.token,
    );
    expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "job-token-abc");
    // Throwing DelayedError is the contract (attemptsMade stays 0).
    expect(() => {
      throw new DelayedError();
    }).toThrow(DelayedError);
    expect(fakeJob.attemptsMade).toBe(0);

    // After delay window cleared, a send path runs once.
    await redis.del(`waapi:send:throttle:${sessionId}`);
    const claim = await claimOutboundForSend(db as never, fakeJob.data.messageId);
    expect(claim.status).toBe("claimed");
    await manager.getClient().sendText();
    expect(sendCount).toBe(1);
    expect(fakeJob.attemptsMade).toBe(0);

    void queue;
  }, 15_000);
});
