import { encryptPayloadJson } from "@waapi/shared";
import { config } from "../config.js";
import { outboxKeyResolver } from "./payload-crypto.js";

/** Encrypt a full webhook payload for webhook_outbox (AAD = outbox id). */
export function encryptOutboxPayload(
  payload: Record<string, unknown>,
  outboxId: string,
): Record<string, unknown> {
  const version = config.PAYLOAD_ENCRYPTION_KEY_VERSION ?? "v1";
  const key = outboxKeyResolver()(version);
  return encryptPayloadJson(JSON.stringify(payload), outboxId, key, version) as unknown as Record<
    string,
    unknown
  >;
}
