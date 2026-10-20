import { parsePhoneNumberFromString } from "libphonenumber-js";

const JID_RE = /^[1-9]\d{6,14}@s\.whatsapp\.net$/;

export function toWhatsAppJid(input: string): string {
  const trimmed = input.trim();
  if (JID_RE.test(trimmed)) return trimmed;

  const phone = parsePhoneNumberFromString(trimmed);
  if (!phone?.isValid()) {
    const error = new Error("Phone number must be valid E.164 or WhatsApp JID");
    Object.assign(error, { statusCode: 400, code: "INVALID_PHONE" });
    throw error;
  }
  return `${phone.number.slice(1)}@s.whatsapp.net`;
}
