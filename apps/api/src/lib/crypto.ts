import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const randomToken = (prefix = ""): string =>
  prefix + randomBytes(32).toString("base64url");

export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function key(): Buffer {
  const value = config.WEBHOOK_SECRET_KEY;
  const decoded = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (decoded.length !== 32) throw new Error("WEBHOOK_SECRET_KEY must decode to 32 bytes");
  return decoded;
}

const KEY_VERSION = "v1";

/** Encrypt with version prefix + AAD (endpoint id). */
export function encryptSecret(value: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const packed = [iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64url"))
    .join(".");
  return `${KEY_VERSION}.${packed}`;
}

export function decryptSecret(value: string, aad: string): string {
  // Legacy format without version prefix (3 base64url parts)
  if (!value.startsWith(`${KEY_VERSION}.`)) {
    const [ivText, tagText, ciphertextText] = value.split(".");
    if (!ivText || !tagText || !ciphertextText) throw new Error("Invalid encrypted secret");
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
  const rest = value.slice(KEY_VERSION.length + 1);
  const [ivText, tagText, ciphertextText] = rest.split(".");
  if (!ivText || !tagText || !ciphertextText) throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivText, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
