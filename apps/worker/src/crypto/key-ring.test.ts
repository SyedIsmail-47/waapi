import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { buildKeyRing } from "./key-ring.js";

describe("EncryptionKeyRing", () => {
  it("decrypt path uses versioned key", () => {
    const v1 = randomBytes(32);
    const v2 = randomBytes(32);
    const ring = buildKeyRing({
      currentVersion: 2,
      currentKeyRaw: v2.toString("base64"),
      ringJson: JSON.stringify({ "1": v1.toString("base64"), "2": v2.toString("base64") }),
    });
    expect(ring.current.version).toBe(2);
    expect(ring.get(1).equals(v1)).toBe(true);
    expect(() => ring.get(3)).toThrow(/version 3/);
  });
});
