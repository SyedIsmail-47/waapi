import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedBlob = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
};

export function encryptAesGcm(plaintext: Buffer, key: Buffer): EncryptedBlob {
  if (key.length !== 32) throw new Error("AES-256-GCM key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

export function decryptAesGcm(blob: EncryptedBlob, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("AES-256-GCM key must be 32 bytes");
  const decipher = createDecipheriv("aes-256-gcm", key, blob.iv);
  decipher.setAuthTag(blob.authTag);
  return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
}

export function encryptJson(value: unknown, key: Buffer): EncryptedBlob {
  return encryptAesGcm(Buffer.from(JSON.stringify(value), "utf8"), key);
}

export function decryptJson<T>(blob: EncryptedBlob, key: Buffer): T {
  const raw = decryptAesGcm(blob, key).toString("utf8");
  return JSON.parse(raw) as T;
}
