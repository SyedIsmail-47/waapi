import {
  buildPayloadKeyResolver,
  encryptPayloadJson,
  type EncryptedPayloadEnvelope,
} from "@waapi/shared";
import { loadConfig } from "../config.js";

export function encryptOutboxPayload(
  payload: Record<string, unknown>,
  outboxId: string,
): EncryptedPayloadEnvelope {
  const cfg = loadConfig();
  const version = cfg.payloadEncryptionKeyVersion;
  const resolve = buildPayloadKeyResolver({
    currentVersion: version,
    currentKey: cfg.payloadEncryptionKey,
    currentKeyName: "PAYLOAD_ENCRYPTION_KEY",
    ringJson: cfg.payloadEncryptionKeyRing,
  });
  return encryptPayloadJson(JSON.stringify(payload), outboxId, resolve(version), version);
}
