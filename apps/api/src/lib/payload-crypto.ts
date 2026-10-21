import { createHash } from "node:crypto";
import {
  buildPayloadKeyResolver,
  decryptPayloadJson as decryptShared,
  encryptPayloadJson as encryptShared,
  isEncryptedPayload,
  type EncryptedPayloadEnvelope,
  type PayloadKeyResolver,
} from "@waapi/shared";
import { config } from "../config.js";

export type { EncryptedPayloadEnvelope };
export { isEncryptedPayload };

/** Delivery payloads: WEBHOOK_SECRET_KEY (legacy + current). */
function deliveryKeyResolver(): PayloadKeyResolver {
  return buildPayloadKeyResolver({
    currentVersion: config.WEBHOOK_PAYLOAD_KEY_VERSION ?? "v1",
    currentKey: config.WEBHOOK_SECRET_KEY,
    currentKeyName: "WEBHOOK_SECRET_KEY",
    ringJson: config.WEBHOOK_PAYLOAD_KEY_RING,
  });
}

/** Outbox payloads: PAYLOAD_ENCRYPTION_KEY. */
export function outboxKeyResolver(): PayloadKeyResolver {
  return buildPayloadKeyResolver({
    currentVersion: config.PAYLOAD_ENCRYPTION_KEY_VERSION ?? "v1",
    currentKey: config.PAYLOAD_ENCRYPTION_KEY,
    currentKeyName: "PAYLOAD_ENCRYPTION_KEY",
    ringJson: config.PAYLOAD_ENCRYPTION_KEY_RING,
  });
}

export function encryptPayloadJson(
  plaintextJson: string,
  aad: string,
  version = config.WEBHOOK_PAYLOAD_KEY_VERSION ?? "v1",
): EncryptedPayloadEnvelope {
  return encryptShared(
    plaintextJson,
    aad,
    deliveryKeyResolver()(version),
    version,
  );
}

export function decryptPayloadJson(
  envelope: Record<string, unknown> | null | undefined,
  aad: string,
): string {
  return decryptShared(envelope, aad, deliveryKeyResolver());
}

export function decryptOutboxPayloadJson(
  envelope: Record<string, unknown> | null | undefined,
  aad: string,
): string {
  return decryptShared(envelope, aad, outboxKeyResolver());
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
