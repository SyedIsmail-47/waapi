import { z } from "zod";
import { sessionStatusSchema } from "./session.js";

export const createSessionBodySchema = z.object({
  name: z.string().min(1).max(120),
});

export const updateSessionBodySchema = z.object({
  name: z.string().min(1).max(120),
});

export const sendMessageBodySchema = z.object({
  sessionId: z.string().uuid(),
  to: z.string().min(1).max(64),
  text: z.string().min(1).max(65536),
});

export const upsertWebhookBodySchema = z.object({
  url: z.string().url().max(2048),
  secret: z.string().min(16).max(256).optional(),
  enabled: z.boolean().optional().default(true),
});

/** Public session shape — nodeId / authKeyVersion never included. */
export const sessionDtoSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  name: z.string(),
  status: sessionStatusSchema,
  phoneNumber: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const sessionStatusResponseSchema = z.object({
  id: z.string().uuid(),
  status: sessionStatusSchema,
  phoneNumber: z.string().nullable(),
  lastError: z.string().nullable(),
  qr: z
    .object({
      value: z.string(),
      updatedAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
    })
    .nullable(),
  qrExpired: z.boolean().optional(),
});

export const sendMessageResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["queued", "failed", "in_progress"]),
});
