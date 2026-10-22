/**
 * Shared WAClient contract tests. Run against the fake driver (and any
 * future in-process drivers). Baileys itself is not exercised here —
 * it needs a live WhatsApp network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WAClient } from "./types.js";
import { createFakeClient, FakeControl, type FakeClientOptions } from "./fake-client.js";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function createUnderTest(opts?: Partial<FakeClientOptions>): Promise<WAClient> {
  return createFakeClient({
    sessionId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    ...opts,
  });
}

describe("WAClient contract (fake driver)", () => {
  afterEach(() => {
    FakeControl.clear();
  });

  it("emits qr then reaches need_scan path via qr event after connect", async () => {
    const client = await createUnderTest({ qrDelayMs: 5 });
    const qrs: string[] = [];
    client.on("qr", (qr) => qrs.push(qr));
    await client.connect();
    await waitFor(() => qrs.length >= 1);
    expect(qrs[0]).toMatch(/^FAKE-QR-/);
    expect(client.getStatus()).toBe("connecting");
  });

  it("simulateScan transitions to connected with a phone number", async () => {
    const client = await createUnderTest({ qrDelayMs: 5 });
    const statuses: string[] = [];
    client.on("status", (s) => statuses.push(s));
    await client.connect();
    await waitFor(() => FakeControl.get(client.sessionId)?.lastQr != null);
    await FakeControl.scan(client.sessionId);
    await waitFor(() => client.getStatus() === "connected");
    expect(statuses).toContain("connected");
    const detailPhone = FakeControl.get(client.sessionId)?.phoneNumber;
    expect(detailPhone).toMatch(/^\+/);
  });

  it("sendText succeeds after scan and returns messageId", async () => {
    const client = await createUnderTest({ qrDelayMs: 1 });
    await client.connect();
    await waitFor(() => FakeControl.get(client.sessionId)?.lastQr != null);
    await FakeControl.scan(client.sessionId);
    await waitFor(() => client.getStatus() === "connected");
    const result = await client.sendText("15551234567@s.whatsapp.net", "hello");
    expect(result.messageId).toMatch(/^fake-/);
    expect(result.remoteJid).toContain("@");
  });

  it("injectSendTimeout makes the next sendText reject with timeout", async () => {
    const client = await createUnderTest({ qrDelayMs: 1 });
    await client.connect();
    await waitFor(() => FakeControl.get(client.sessionId)?.lastQr != null);
    await FakeControl.scan(client.sessionId);
    await waitFor(() => client.getStatus() === "connected");
    FakeControl.injectSendTimeout(client.sessionId);
    await expect(client.sendText("1@s.whatsapp.net", "x")).rejects.toThrow(/timeout/i);
  });

  it("injectBan emits error status with ban detail", async () => {
    const client = await createUnderTest({ qrDelayMs: 1 });
    const details: Array<{ error?: string }> = [];
    client.on("status", (_s, d) => {
      if (d) details.push(d);
    });
    await client.connect();
    await waitFor(() => FakeControl.get(client.sessionId)?.lastQr != null);
    await FakeControl.scan(client.sessionId);
    await waitFor(() => client.getStatus() === "connected");
    await FakeControl.injectBan(client.sessionId);
    await waitFor(() => client.getStatus() === "error");
    expect(details.some((d) => /ban/i.test(d.error ?? ""))).toBe(true);
  });

  it("injectInbound emits messageMeta without logging body paths", async () => {
    const client = await createUnderTest({ qrDelayMs: 1 });
    const metas: Array<{ messageId: string; text?: string }> = [];
    client.on("messageMeta", (m) => metas.push(m));
    await client.connect();
    await waitFor(() => FakeControl.get(client.sessionId)?.lastQr != null);
    await FakeControl.scan(client.sessionId);
    await waitFor(() => client.getStatus() === "connected");
    await FakeControl.injectInbound(client.sessionId, {
      remoteJid: "15550001111@s.whatsapp.net",
      text: "secret-body-not-for-logs",
    });
    await waitFor(() => metas.length === 1);
    expect(metas[0]!.messageId).toBeTruthy();
    expect(metas[0]!.text).toBe("secret-body-not-for-logs");
  });

  it("disconnect and dispose are idempotent", async () => {
    const client = await createUnderTest({ qrDelayMs: 1 });
    await client.connect();
    await client.disconnect();
    await client.disconnect({ flush: false });
    client.closeAuth();
    await client.flushAuth();
    client.dispose();
    client.dispose();
    expect(client.getStatus()).toBe("disconnected");
  });

  it("FakeControl.scan on unknown session throws", async () => {
    await expect(FakeControl.scan("00000000-0000-4000-8000-000000000099")).rejects.toThrow(
      /not found/i,
    );
  });
});

// Ensure the contract module is importable before fake-client exists (TDD red).
void vi;
