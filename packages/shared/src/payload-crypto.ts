import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ENC_MARKER = "__enc" as const;

export type EncryptedPayloadEnvelope = { [ENC_MARKER]: string };

export function decodeKey32(value: string, name: string): Buffer {
  const decoded = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (decoded.length !== 32) throw new Error(`${name} must decode to 32 bytes`);
  return decoded;
}

export type PayloadKeyResolver = (version: string) => Buffer;

export function encryptPayloadJson(
  plaintextJson: string,
  aad: string,
  key: Buffer,
  version: string,
): EncryptedPayloadEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
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
  resolveKey: PayloadKeyResolver,
): string {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("Missing encrypted payload");
  }
  if (!(ENC_MARKER in envelope)) {
    // Legacy plaintext jsonb — caller may reject; still parseable once.
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
    resolveKey(version),
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

export function hashPayloadPlaintext(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Build a versioned key resolver from current key + optional ring JSON. */
export function buildPayloadKeyResolver(opts: {
  currentVersion: string;
  currentKey: string;
  currentKeyName?: string;
  ringJson?: string;
}): PayloadKeyResolver {
  const current = decodeKey32(opts.currentKey, opts.currentKeyName ?? "PAYLOAD_ENCRYPTION_KEY");
  let ring: Record<string, string> = {};
  if (opts.ringJson) {
    ring = JSON.parse(opts.ringJson) as Record<string, string>;
  }
  return (version: string) => {
    if (version === opts.currentVersion) return current;
    const material = ring[version];
    if (!material) throw new Error(`Unknown payload key version ${version}`);
    return decodeKey32(material, `PAYLOAD_ENCRYPTION_KEY_RING.${version}`);
  };
}
