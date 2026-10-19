import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  authAad,
  decryptJson,
  encryptJson,
  parseEncryptionKeyMaterial,
} from "./aes.js";

describe("aes-256-gcm", () => {
  it("round-trips JSON with AAD and ciphertext differs from plaintext", () => {
    const key = randomBytes(32);
    const value = { hello: "world", n: 42 };
    const aad = authAad("sess-1", "creds", "default");
    const blob = encryptJson(value, key, aad);
    expect(blob.ciphertext.includes(Buffer.from("world"))).toBe(false);
    expect(decryptJson<typeof value>(blob, key, aad)).toEqual(value);
  });

  it("fails decrypt when AAD does not match", () => {
    const key = randomBytes(32);
    const value = { secret: true };
    const blob = encryptJson(value, key, authAad("sess-1", "creds", "default"));
    expect(() =>
      decryptJson(blob, key, authAad("sess-1", "creds", "other")),
    ).toThrow();
  });

  it("accepts base64 and 64-char hex keys of exactly 32 bytes", () => {
    const raw = randomBytes(32);
    expect(parseEncryptionKeyMaterial(raw.toString("base64")).equals(raw)).toBe(true);
    expect(parseEncryptionKeyMaterial(raw.toString("hex")).equals(raw)).toBe(true);
    expect(() => parseEncryptionKeyMaterial(Buffer.alloc(16).toString("base64"))).toThrow(
      /exactly 32 bytes/,
    );
  });
});
