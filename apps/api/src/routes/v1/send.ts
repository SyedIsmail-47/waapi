import type { FastifyPluginAsync } from "fastify";
import { sendMessageBodySchema } from "@waapi/shared";
import { config } from "../../config.js";
import { sendText } from "../../services/send.js";

const routes: FastifyPluginAsync = async (app) => {
  app.post(
    "/send-message",
    {
      preHandler: app.requireAuthType("jwt", "pat", "session_key"),
      config: { rateLimit: { max: config.SEND_RATE_LIMIT_MAX } },
    },
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !key || key.length > 128) {
        throw Object.assign(new Error("Idempotency-Key header required"), {
          statusCode: 400,
          code: "VALIDATION_ERROR",
        });
      }
      const input = sendMessageBodySchema.parse(request.body);
      if (
        request.identity.authType === "session_key" &&
        request.identity.sessionId !== input.sessionId
      ) {
        throw Object.assign(new Error("Session not found"), {
          statusCode: 404,
          code: "NOT_FOUND",
        });
      }
      return reply
        .code(202)
        .send(await sendText(app.database, request.identity.accountId, input, key, request.id));
    },
  );
};
export default routes;
