import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptJson, encryptJson } from "./aes.js";

describe("aes-256-gcm", () => {
  it("round-trips JSON and ciphertext differs from plaintext", () => {
    const key = randomBytes(32);
    const value = { hello: "world", n: 42 };
    const blob = encryptJson(value, key);
    expect(blob.ciphertext.includes(Buffer.from("world"))).toBe(false);
    expect(decryptJson<typeof value>(blob, key)).toEqual(value);
  });
});
