import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedBlob = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
};

export function parseEncryptionKeyMaterial(raw: string): Buffer {
  const trimmed = raw.trim();
  // Prefer hex when it looks like 32 bytes (64 hex chars)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, "hex");
    if (buf.length !== 32) {
      throw new Error("AUTH_STATE_ENCRYPTION_KEY hex must decode to exactly 32 bytes");
    }
    return buf;
  }
  const buf = Buffer.from(trimmed, "base64");
  if (buf.length !== 32) {
    throw new Error(
      "AUTH_STATE_ENCRYPTION_KEY must be exactly 32 bytes (base64-encoded or 64-char hex)",
    );
  }
  return buf;
}

export function encryptAesGcm(
  plaintext: Buffer,
  key: Buffer,
  aad: string | Buffer,
): EncryptedBlob {
  if (key.length !== 32) throw new Error("AES-256-GCM key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(typeof aad === "string" ? Buffer.from(aad, "utf8") : aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

export function decryptAesGcm(
  blob: EncryptedBlob,
  key: Buffer,
  aad: string | Buffer,
): Buffer {
  if (key.length !== 32) throw new Error("AES-256-GCM key must be 32 bytes");
  const decipher = createDecipheriv("aes-256-gcm", key, blob.iv);
  decipher.setAAD(typeof aad === "string" ? Buffer.from(aad, "utf8") : aad);
  decipher.setAuthTag(blob.authTag);
  return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
}

export function encryptJson(
  value: unknown,
  key: Buffer,
  aad: string | Buffer,
): EncryptedBlob {
  return encryptAesGcm(Buffer.from(JSON.stringify(value), "utf8"), key, aad);
}

export function decryptJson<T>(
  blob: EncryptedBlob,
  key: Buffer,
  aad: string | Buffer,
): T {
  const raw = decryptAesGcm(blob, key, aad).toString("utf8");
  return JSON.parse(raw) as T;
}

export function authAad(sessionId: string, type: string, id: string): string {
  return `${sessionId}:${type}:${id}`;
}
