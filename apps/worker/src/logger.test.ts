import { describe, expect, it } from "vitest";
import { assertSafeLogPayload } from "./logger.js";

describe("assertSafeLogPayload", () => {
  it("allows metadata keys", () => {
    expect(() =>
      assertSafeLogPayload({
        sessionId: "x",
        messageId: "y",
        messageType: "conversation",
        remoteJid: "1@s.whatsapp.net",
      }),
    ).not.toThrow();
  });

  it("rejects message body keys", () => {
    expect(() => assertSafeLogPayload({ conversation: "hi" })).toThrow(/Forbidden/);
    expect(() => assertSafeLogPayload({ text: "hi" })).toThrow(/Forbidden/);
  });
});
