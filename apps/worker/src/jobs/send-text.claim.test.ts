import { describe, expect, it, vi } from "vitest";
import { claimOutboundForSend } from "./send-text.js";

describe("claimOutboundForSend", () => {
  it("claims a queued row", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ id: "m1" }]),
      select: vi.fn(),
    };
    await expect(claimOutboundForSend(db as never, "m1")).resolves.toEqual({
      status: "claimed",
    });
  });

  it("skips when already sent", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([]),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ status: "sent", providerMessageId: "wamid" }],
          }),
        }),
      }),
    };
    await expect(claimOutboundForSend(db as never, "m1")).resolves.toEqual({
      status: "already_sent",
    });
  });

  it("reports busy when another attempt holds sending", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([]),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ status: "sending", providerMessageId: null }],
          }),
        }),
      }),
    };
    await expect(claimOutboundForSend(db as never, "m1")).resolves.toEqual({
      status: "busy",
    });
  });
});
