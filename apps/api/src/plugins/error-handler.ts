import fp from "fastify-plugin";
import { ZodError } from "zod";

export default fp(async (app) => {
  app.setErrorHandler((error, request, reply) => {
    const value = error as Error & { statusCode?: number; code?: string; validation?: unknown };
    const validation = value instanceof ZodError || value.validation;
    const status = validation ? 400 : value.statusCode ?? 500;
    const code = status === 429 ? "RATE_LIMITED" : validation ? "VALIDATION_ERROR" : value.code ?? "INTERNAL_ERROR";
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
