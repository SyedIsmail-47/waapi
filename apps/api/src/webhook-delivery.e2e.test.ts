import { createServer, type IncomingMessage, type ServerResponse, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  assertPublicUrl,
  createPinnedLookup,
  dumpBodyLimited,
  resolveAndValidate,
} from "./services/webhooks/ssrf.js";
import { signWebhook, verifySignature } from "./services/webhooks/sign.js";
import { encryptSecret, decryptSecret } from "./lib/crypto.js";
import { backoffWithJitter } from "./workers/webhook-delivery.js";

describe("webhook delivery e2e / SSRF", () => {
  const prevHttp = process.env.ALLOW_HTTP_WEBHOOKS;
  beforeAll(() => {
    process.env.ALLOW_HTTP_WEBHOOKS = "true";
    process.env.WEBHOOK_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");
  });
  afterAll(() => {
    process.env.ALLOW_HTTP_WEBHOOKS = prevHttp;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("default agent blocks 127.0.0.1", async () => {
    await expect(assertPublicUrl("http://127.0.0.1/hook")).rejects.toMatchObject({
      code: "SSRF_BLOCKED",
    });
  });

  it("pinned lookup handles all:true callback form (array)", async () => {
    const lookup = createPinnedLookup({
      lookup: (_hostname, _opts, cb) => {
        cb(null, "8.8.8.8", 4);
      },
    });
    const address = await new Promise<unknown>((resolve, reject) => {
      lookup("example.com", { all: true }, (err, addr) => {
        if (err) reject(err);
        else resolve(addr);
      });
    });
    expect(Array.isArray(address)).toBe(true);
    expect(address).toEqual([{ address: "8.8.8.8", family: 4 }]);

    const single = await new Promise<unknown>((resolve, reject) => {
      lookup("example.com", {}, (err, addr, family) => {
        if (err) reject(err);
        else resolve({ addr, family });
      });
    });
    expect(single).toEqual({ addr: "8.8.8.8", family: 4 });
  });

  it("signed delivery verifies against local HTTP server", async () => {
    const secret = "webhook-e2e-secret-value";
    const received: { headers: IncomingMessage["headers"]; body: string }[] = [];
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ headers: req.headers, body });
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;

    const endpointId = randomUUID();
    const enc = encryptSecret(secret, endpointId);
    expect(enc.startsWith("v1.")).toBe(true);
    expect(decryptSecret(enc, endpointId)).toBe(secret);
    expect(() => decryptSecret(enc, randomUUID())).toThrow();

    const body = JSON.stringify({ type: "session.status", id: randomUUID() });
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = signWebhook(secret, timestamp, body);

    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: "/",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "x-waapi-signature": `sha256=${sig}`,
            "x-waapi-timestamp": String(timestamp),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end(body);
    });

    expect(received).toHaveLength(1);
    expect(
      verifySignature(
        secret,
        Number(received[0]!.headers["x-waapi-timestamp"]),
        received[0]!.body,
        String(received[0]!.headers["x-waapi-signature"]),
      ),
    ).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("DNS rebinding stub rejects when any address is private", async () => {
    await expect(
      resolveAndValidate("rebind.example", async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ] as never),
    ).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
  });

  it("private IP redirect target is blocked at resolve time", async () => {
    await expect(resolveAndValidate("127.0.0.1")).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
  });

  it("response bodies over 64KB: stop reading, do not throw", async () => {
    const big = Buffer.alloc(70 * 1024, 0x61);
    let destroyed = false;
    const body = Readable.from([big]) as unknown as import("undici").Dispatcher.ResponseData["body"];
    Object.assign(body, {
      destroy: () => {
        destroyed = true;
      },
    });
    const result = await dumpBodyLimited(body);
    expect(result.truncated).toBe(true);
    expect(destroyed).toBe(true);
  });

  it("backoff schedule spans ~15 attempts toward ~24h", () => {
    let sum = 0;
    for (let i = 0; i < 15; i++) {
      const d = backoffWithJitter(i);
      expect(d).toBeGreaterThan(0);
      sum += d;
    }
    expect(sum).toBeGreaterThan(6 * 60 * 60_000);
    expect(sum).toBeLessThan(30 * 60 * 60_000);
  });
});
