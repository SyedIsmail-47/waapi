import type { FastifyPluginAsync } from "fastify";
import { createSessionBodySchema } from "@waapi/shared";
import { z } from "zod";
import {
  command,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  status,
} from "../../services/sessions.js";
import { createSessionKey, revokeSessionKey } from "../../services/tokens.js";

const paramsSchema = z.object({ id: z.string().uuid() });

const notFound = () =>
  Object.assign(new Error("Session not found"), { statusCode: 404, code: "NOT_FOUND" });

const routes: FastifyPluginAsync = async (app) => {
  const accountAuth = { preHandler: app.requireAuthType("jwt", "pat") };

  app.post("/", accountAuth, async (request, reply) =>
    reply
      .code(201)
      .send(
        await createSession(
          app.database,
          request.identity.accountId,
          createSessionBodySchema.parse(request.body).name,
          request.id,
        ),
      ),
  );

  app.get("/", accountAuth, async (request) =>
    listSessions(app.database, request.identity.accountId),
  );

  app.get<{ Params: { id: string } }>("/:id", accountAuth, async (request) =>
    getSession(app.database, request.identity.accountId, paramsSchema.parse(request.params).id),
  );

  app.delete<{ Params: { id: string } }>("/:id", accountAuth, async (request, reply) => {
    await deleteSession(
      app.database,
      request.identity.accountId,
      paramsSchema.parse(request.params).id,
    );
    return reply.code(204).send();
  });

  for (const action of ["connect", "disconnect", "logout"] as const) {
    app.post<{ Params: { id: string } }>(`/:id/${action}`, accountAuth, async (request, reply) => {
      await command(
        app.database,
        request.identity.accountId,
        paramsSchema.parse(request.params).id,
        action,
        request.id,
      );
      return reply.code(202).send({ queued: true });
    });
  }

  app.get<{ Params: { id: string } }>(
    "/:id/status",
    { preHandler: app.requireAuthType("jwt", "pat", "session_key") },
    async (request) => {
      const id = paramsSchema.parse(request.params).id;
      if (
        request.identity.authType === "session_key" &&
        request.identity.sessionId !== id
      ) {
        throw notFound();
      }
      return status(app.database, request.identity.accountId, id);
    },
  );

  app.post<{ Params: { id: string } }>("/:id/keys", accountAuth, async (request, reply) => {
    const body = z.object({ name: z.string().min(1).max(80) }).parse(request.body);
    return reply
      .code(201)
      .send(
        await createSessionKey(
          app.database,
          request.identity.accountId,
          paramsSchema.parse(request.params).id,
          body.name,
        ),
      );
  });

  app.delete<{ Params: { id: string; keyId: string } }>(
    "/:id/keys/:keyId",
    accountAuth,
    async (request, reply) => {
      const parsed = z
        .object({ id: z.string().uuid(), keyId: z.string().uuid() })
        .parse(request.params);
      await revokeSessionKey(
        app.database,
        request.identity.accountId,
        parsed.id,
        parsed.keyId,
      );
      return reply.code(204).send();
    },
  );
};
export default routes;
