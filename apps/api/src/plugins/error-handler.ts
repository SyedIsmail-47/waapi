import fp from "fastify-plugin";
import { ZodError } from "zod";

export default fp(async (app) => {
  app.setErrorHandler((error, request, reply) => {
    const value = error as Error & {
      statusCode?: number;
      code?: string;
      validation?: unknown;
      after?: string | number;
    };
    // Single workspace Zod (pnpm override) — instanceof is reliable again.
    const validation = value instanceof ZodError || Boolean(value.validation);
    /**
     * Cause of prior rate-limit 500s: @fastify/rate-limit throws
     * errorResponseBuilder()'s return value. When that was a plain
     * `{ error: {...} }` object (no statusCode), this line resolved to 500:
     *   `value.statusCode ?? 500`
     * Fix: builder returns Error-like with statusCode 429, and we only trust
     * a numeric statusCode below 500 (4xx client errors).
     */
    const rawStatus = value.statusCode;
    const status = validation
      ? 400
      : typeof rawStatus === "number" && Number.isFinite(rawStatus) && rawStatus < 500
        ? rawStatus
        : 500;
    const code =
      status === 429
        ? value.code ?? "RATE_LIMITED"
        : validation
          ? "VALIDATION_ERROR"
          : value.code ?? "INTERNAL_ERROR";
    if (status === 429 && reply.getHeader("retry-after") == null) {
      const after = value.after ?? (value as { retryAfter?: unknown }).retryAfter;
      const seconds =
        typeof after === "number" && Number.isFinite(after)
          ? Math.max(1, Math.ceil(after))
          : typeof after === "string" && /^\d+$/.test(after)
            ? Number(after)
            : 60;
      reply.header("Retry-After", String(seconds));
    }
    if (status >= 500) request.log.error(error);
    reply.status(status).send({
      error: {
        code,
        message: status >= 500 ? "Internal server error" : value.message,
        requestId: request.id,
      },
    });
  });
});
