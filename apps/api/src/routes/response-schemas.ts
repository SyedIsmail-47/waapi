/**
 * Response schemas for every public route (validated in route-schemas.test.ts).
 * Handlers still parse request bodies manually; these document and guard shapes.
 *
 * Schemas are typed as ZodTypeAny to avoid TS2589 deep instantiation on complex
 * shared Zod objects (sessionDtoSchema et al.) during `tsc`.
 */
import {
  sendMessageResponseSchema,
  sessionDtoSchema,
  sessionStatusResponseSchema,
} from "@waapi/shared";
import { z } from "zod";

const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});

const accepted = z.object({ queued: z.literal(true) });
const deleteAccepted = z.object({ id: z.string().uuid(), accepted: z.literal(true) });
const tokens = z.object({ accessToken: z.string(), refreshToken: z.string() });
const empty = z.null().or(z.undefined()).or(z.object({}).strict());

type RouteResponseSchema = {
  method: string;
  url: string;
  status: number;
  schema: z.ZodTypeAny;
};

const sessionDto = sessionDtoSchema as unknown as z.ZodTypeAny;
const sessionStatus = sessionStatusResponseSchema as unknown as z.ZodTypeAny;
const sendMessageResponse = sendMessageResponseSchema as unknown as z.ZodTypeAny;

export const routeResponseSchemas: RouteResponseSchema[] = [
  { method: "GET", url: "/health", status: 200, schema: z.object({ ok: z.boolean() }).passthrough() },
  { method: "POST", url: "/api/v1/auth/register", status: 201, schema: z.object({ userId: z.string().uuid(), accountId: z.string().uuid() }).passthrough() },
  { method: "POST", url: "/api/v1/auth/login", status: 200, schema: tokens },
  { method: "POST", url: "/api/v1/auth/refresh", status: 200, schema: tokens },
  { method: "POST", url: "/api/v1/auth/verify-email", status: 204, schema: empty },
  { method: "POST", url: "/api/v1/auth/resend-verification", status: 202, schema: empty },
  { method: "POST", url: "/api/v1/auth/forgot-password", status: 202, schema: empty },
  { method: "POST", url: "/api/v1/auth/reset-password", status: 204, schema: empty },
  { method: "POST", url: "/api/v1/auth/logout-all", status: 204, schema: empty },
  { method: "POST", url: "/api/v1/auth/change-password", status: 204, schema: empty },
  { method: "POST", url: "/api/v1/auth/delete-account", status: 204, schema: empty },
  { method: "POST", url: "/api/v1/auth/tokens", status: 201, schema: z.object({ id: z.string().uuid(), token: z.string() }).passthrough() },
  { method: "GET", url: "/api/v1/auth/tokens", status: 200, schema: z.array(z.object({ id: z.string().uuid() }).passthrough()) },
  { method: "DELETE", url: "/api/v1/auth/tokens/:id", status: 204, schema: empty },
  { method: "POST", url: "/api/v1/sessions", status: 201, schema: sessionDto },
  { method: "GET", url: "/api/v1/sessions", status: 200, schema: z.array(sessionDto) },
  { method: "GET", url: "/api/v1/sessions/:id", status: 200, schema: sessionDto },
  { method: "PATCH", url: "/api/v1/sessions/:id", status: 200, schema: sessionDto },
  { method: "DELETE", url: "/api/v1/sessions/:id", status: 202, schema: deleteAccepted },
  { method: "POST", url: "/api/v1/sessions/:id/connect", status: 202, schema: accepted },
  { method: "POST", url: "/api/v1/sessions/:id/disconnect", status: 202, schema: accepted },
  { method: "POST", url: "/api/v1/sessions/:id/logout", status: 202, schema: accepted },
  { method: "GET", url: "/api/v1/sessions/:id/status", status: 200, schema: sessionStatus },
  { method: "POST", url: "/api/v1/sessions/:id/keys", status: 201, schema: z.object({ id: z.string().uuid(), token: z.string() }).passthrough() },
  { method: "DELETE", url: "/api/v1/sessions/:id/keys/:keyId", status: 204, schema: empty },
  { method: "PUT", url: "/api/v1/sessions/:id/webhook", status: 200, schema: z.object({ id: z.string().uuid(), url: z.string() }).passthrough() },
  { method: "GET", url: "/api/v1/sessions/:id/webhook", status: 200, schema: z.object({ id: z.string().uuid(), url: z.string() }).passthrough() },
  { method: "DELETE", url: "/api/v1/sessions/:id/webhook", status: 204, schema: empty },
  { method: "POST", url: "/api/v1/sessions/:id/webhook/test", status: 202, schema: z.object({ deliveryId: z.string().uuid(), queued: z.literal(true) }) },
  { method: "POST", url: "/api/v1/sessions/:id/webhook/deliveries/:deliveryId/replay", status: 202, schema: z.object({ deliveryId: z.string().uuid(), queued: z.literal(true) }) },
  { method: "POST", url: "/api/v1/send-message", status: 202, schema: sendMessageResponse },
  { method: "GET", url: "/api/v1/messages", status: 200, schema: z.object({ items: z.array(z.unknown()), nextCursor: z.string().nullable() }) },
];

export { errorSchema, sessionDtoSchema, sessionStatusResponseSchema, sendMessageResponseSchema };
