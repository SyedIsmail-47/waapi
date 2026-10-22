import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@waapi/db";

vi.mock("./services/queues.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./services/queues.js")>();
  return {
    ...actual,
    redis: {
      ...actual.redis,
      publish: vi.fn(async () => 1),
    },
  };
});

describe("internal fake WA control", () => {
  let internal: Awaited<ReturnType<typeof import("./app.js").buildInternalApp>>;
  let database: ReturnType<typeof createDb>;
  const secret = process.env.ADMIN_API_SECRET!;

  beforeAll(async () => {
    const { buildInternalApp } = await import("./app.js");
    const { redis } = await import("./services/queues.js");
    vi.mocked(redis.publish).mockClear();
    database = createDb(process.env.DATABASE_URL!);
    internal = await buildInternalApp(database);
    await internal.ready();
  });

  afterAll(async () => {
    await internal.close();
    await database.client.end();
  });

  it("rejects without admin secret", async () => {
    const res = await internal.inject({
      method: "POST",
      url: "/internal/admin/fake/sessions/11111111-1111-4111-8111-111111111111/scan",
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("publishes scan command to Redis when authorized", async () => {
    const { redis } = await import("./services/queues.js");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const res = await internal.inject({
      method: "POST",
      url: `/internal/admin/fake/sessions/${sessionId}/scan`,
      headers: { "x-admin-secret": secret },
      payload: { phoneNumber: "+15551234567" },
    });
    expect(res.statusCode).toBe(202);
    expect(redis.publish).toHaveBeenCalled();
    const [channel, raw] = vi.mocked(redis.publish).mock.calls.at(-1)!;
    expect(channel).toBe("waapi:fake:control");
    const msg = JSON.parse(String(raw)) as {
      op: string;
      sessionId: string;
      phoneNumber?: string;
    };
    expect(msg).toEqual({
      op: "scan",
      sessionId,
      phoneNumber: "+15551234567",
    });
  });
});
