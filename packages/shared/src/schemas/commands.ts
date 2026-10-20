import { z } from "zod";

export const openSessionCommandSchema = z.object({
  type: z.literal("open-session"),
  accountId: z.string().uuid(),
  sessionId: z.string().uuid(),
  requestId: z.string().optional(),
});

export const closeSessionCommandSchema = z.object({
  type: z.literal("close-session"),
  accountId: z.string().uuid(),
  sessionId: z.string().uuid(),
  requestId: z.string().optional(),
});

export const logoutSessionCommandSchema = z.object({
  type: z.literal("logout-session"),
  accountId: z.string().uuid(),
  sessionId: z.string().uuid(),
  requestId: z.string().optional(),
});

export const sendMessageCommandSchema = z.object({
  type: z.literal("send-message"),
  accountId: z.string().uuid(),
  sessionId: z.string().uuid(),
  to: z.string().min(1),
  text: z.string().min(1).max(65536),
  messageId: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(128).optional(),
  requestId: z.string().optional(),
});

export const workerCommandSchema = z.discriminatedUnion("type", [
  openSessionCommandSchema,
  closeSessionCommandSchema,
  logoutSessionCommandSchema,
  sendMessageCommandSchema,
]);

export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export type OpenSessionCommand = z.infer<typeof openSessionCommandSchema>;
export type CloseSessionCommand = z.infer<typeof closeSessionCommandSchema>;
export type LogoutSessionCommand = z.infer<typeof logoutSessionCommandSchema>;
export type SendMessageCommand = z.infer<typeof sendMessageCommandSchema>;
