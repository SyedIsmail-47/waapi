import { z } from "zod";
import { SESSION_STATUSES } from "../constants.js";

export const sessionStatusSchema = z.enum(SESSION_STATUSES);

export const sendTextJobSchema = z.object({
  accountId: z.string().uuid(),
  sessionId: z.string().uuid(),
  to: z.string().min(1),
  /** Present until `redacted: true`. Literal "[redacted]" is a valid message body. */
  text: z.string().max(65536).optional(),
  redacted: z.boolean().optional().default(false),
  messageId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
  requestId: z.string().optional(),
  sweep: z.boolean().optional(),
});

export type SendTextJob = z.infer<typeof sendTextJobSchema>;

export const sessionStatusEventSchema = z.object({
  sessionId: z.string().uuid(),
  accountId: z.string().uuid(),
  status: sessionStatusSchema,
  at: z.string().datetime(),
  lastError: z.string().nullable().optional(),
});

export type SessionStatusEvent = z.infer<typeof sessionStatusEventSchema>;

export const qrEventSchema = z.object({
  sessionId: z.string().uuid(),
  qr: z.string().min(1),
  at: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});

export type QrEvent = z.infer<typeof qrEventSchema>;
