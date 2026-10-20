import type { FastifyPluginAsync } from "fastify";
import { upsertWebhookBodySchema } from "@waapi/shared";
import { z } from "zod";
import {
  enqueueDelivery,
  getWebhook,
  removeWebhook,
  testWebhook,
  upsertWebhook,
} from "../../services/webhooks/index.js";

const params = z.object({ id: z.string().uuid() });

const routes: FastifyPluginAsync = async (app) => {
  const accountAuth = { preHandler: app.requireAuthType("jwt", "pat") };

  app.put<{ Params: { id: string } }>("/:id/webhook", accountAuth, async (request) =>
    upsertWebhook(
      app.database,
      request.identity.accountId,
      params.parse(request.params).id,
      upsertWebhookBodySchema.parse(request.body),
    ),
  );

  app.get<{ Params: { id: string } }>("/:id/webhook", accountAuth, async (request) =>
    getWebhook(app.database, request.identity.accountId, params.parse(request.params).id),
  );

  app.delete<{ Params: { id: string } }>("/:id/webhook", accountAuth, async (request, reply) => {
    await removeWebhook(
      app.database,
      request.identity.accountId,
      params.parse(request.params).id,
    );
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>(
    "/:id/webhook/test",
    accountAuth,
    async (request, reply) => {
      const deliveryId = await testWebhook(
        app.database,
        request.identity.accountId,
        params.parse(request.params).id,
      );
      await enqueueDelivery(deliveryId);
      return reply.code(202).send({ deliveryId, queued: true });
    },
  );
};
export default routes;
