import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptJson, encryptJson } from "../crypto/aes.js";

describe("auth state encryption shape", () => {
  it("stores opaque ciphertext for creds-like objects", () => {
    const key = randomBytes(32);
    const creds = { noiseKey: { private: Buffer.from("abc") }, me: { id: "1" } };
    const blob = encryptJson(JSON.parse(JSON.stringify(creds)), key);
    expect(blob.ciphertext.toString("utf8")).not.toContain("noiseKey");
    const round = decryptJson<typeof creds>(blob, key);
    expect(round.me).toEqual({ id: "1" });
  });
});
