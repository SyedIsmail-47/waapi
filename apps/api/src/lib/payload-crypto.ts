import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";

const ENC_MARKER = "__enc" as const;

export type EncryptedPayloadEnvelope = { [ENC_MARKER]: string };

function decodeKey32(value: string, name: string): Buffer {
  const decoded = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (decoded.length !== 32) throw new Error(`${name} must decode to 32 bytes`);
  return decoded;
}

/**
 * Key ring: current version from WEBHOOK_PAYLOAD_KEY_VERSION (default v1)
 * uses WEBHOOK_SECRET_KEY. Optional WEBHOOK_PAYLOAD_KEY_RING JSON map of
 * older versions for decrypt: {"v0":"<base64|hex>"}.
 */
function keyForVersion(version: string): Buffer {
  if (version === (config.WEBHOOK_PAYLOAD_KEY_VERSION ?? "v1")) {
    return decodeKey32(config.WEBHOOK_SECRET_KEY, "WEBHOOK_SECRET_KEY");
  }
  const ringRaw = config.WEBHOOK_PAYLOAD_KEY_RING;
  if (!ringRaw) throw new Error(`Unknown payload key version ${version}`);
  const ring = JSON.parse(ringRaw) as Record<string, string>;
  const material = ring[version];
  if (!material) throw new Error(`Unknown payload key version ${version}`);
  return decodeKey32(material, `WEBHOOK_PAYLOAD_KEY_RING.${version}`);
}

export function encryptPayloadJson(
  plaintextJson: string,
  aad: string,
  version = config.WEBHOOK_PAYLOAD_KEY_VERSION ?? "v1",
): EncryptedPayloadEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyForVersion(version), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintextJson, "utf8"), cipher.final()]);
  const packed = [iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64url"))
    .join(".");
  return { [ENC_MARKER]: `${version}.${packed}` };
}

export function decryptPayloadJson(
  envelope: Record<string, unknown> | null | undefined,
  aad: string,
): string {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("Missing encrypted payload");
  }
  // Legacy plaintext jsonb (pre-round4) — still deliverable once.
  if (!(ENC_MARKER in envelope)) {
    return JSON.stringify(envelope);
  }
  const value = (envelope as EncryptedPayloadEnvelope)[ENC_MARKER];
  if (typeof value !== "string") throw new Error("Invalid encrypted payload");
  const dot = value.indexOf(".");
  if (dot < 1) throw new Error("Invalid encrypted payload version");
  const version = value.slice(0, dot);
  const rest = value.slice(dot + 1);
  const [ivText, tagText, ciphertextText] = rest.split(".");
  if (!ivText || !tagText || !ciphertextText) throw new Error("Invalid encrypted payload");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyForVersion(version),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function isEncryptedPayload(value: unknown): value is EncryptedPayloadEnvelope {
  return (
    typeof value === "object" &&
    value != null &&
    ENC_MARKER in value &&
    typeof (value as EncryptedPayloadEnvelope)[ENC_MARKER] === "string"
  );
}

export function wrapDeliveryPayload(
  payload: Record<string, unknown>,
  deliveryId: string,
): { stored: EncryptedPayloadEnvelope; hash: string; plaintext: string } {
  const plaintext = JSON.stringify(payload);
  return {
    stored: encryptPayloadJson(plaintext, deliveryId),
    hash: createHash("sha256").update(plaintext).digest("hex"),
    plaintext,
  };
}
