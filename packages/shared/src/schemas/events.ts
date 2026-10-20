import { z } from "zod";
import { WEBHOOK_EVENT_TYPES } from "../constants.js";
import { sessionStatusSchema } from "./session.js";

export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

export const webhookEnvelopeSchema = z.object({
  id: z.string().uuid(),
  type: webhookEventTypeSchema,
  accountId: z.string().uuid(),
  sessionId: z.string().uuid(),
  createdAt: z.string().datetime(),
  data: z.record(z.unknown()),
});

export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

export const webhookDeliveryJobSchema = z.object({
  deliveryId: z.string().uuid(),
  endpointId: z.string().uuid(),
  accountId: z.string().uuid(),
  sessionId: z.string().uuid(),
  eventType: webhookEventTypeSchema,
  payload: webhookEnvelopeSchema,
});

export type WebhookDeliveryJob = z.infer<typeof webhookDeliveryJobSchema>;

export const emailJobSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  text: z.string().min(1),
  kind: z.enum(["verify_email", "reset_password", "generic"]),
});

export type EmailJob = z.infer<typeof emailJobSchema>;

export const qrCacheSchema = z.object({
  qr: z.string().min(1),
  at: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type QrCache = z.infer<typeof qrCacheSchema>;

export const sessionStatusPayloadSchema = z.object({
  status: sessionStatusSchema,
  lastError: z.string().nullable().optional(),
  phoneNumber: z.string().nullable().optional(),
});
