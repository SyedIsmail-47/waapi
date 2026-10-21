import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { listMessages } from "../../services/messages.js";

const querySchema = z.object({
  sessionId: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const routes: FastifyPluginAsync = async (app) => {
  app.get(
    "/",
    { preHandler: app.requireAuthType("jwt", "pat", "session_key") },
    async (request) => {
      const query = querySchema.parse(request.query);
      if (request.identity.authType === "session_key") {
        query.sessionId = request.identity.sessionId;
      }
      return listMessages(app.database, request.identity.accountId, query);
    },
  );
};
export default routes;
