import { createHmac, timingSafeEqual } from "node:crypto";

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export const signWebhook = signPayload;

export function verifySignature(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
): boolean {
  const supplied = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const expected = signPayload(secret, timestamp, body);
  if (!/^[0-9a-f]{64}$/i.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));
}
