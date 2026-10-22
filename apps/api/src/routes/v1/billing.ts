import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import {
  getBillingProvider,
  getBillingSnapshot,
  processBillingEvent,
} from "../../services/billing/index.js";

const routes: FastifyPluginAsync = async (app) => {
  app.get(
    "/billing",
    { preHandler: app.requireAuthType("jwt") },
    async (request) => getBillingSnapshot(app.database, request.identity.accountId),
  );

  app.post(
    "/billing/checkout",
    { preHandler: app.requireAuthType("jwt") },
    async (request, reply) => {
      const body = z
        .object({
          planCode: z.enum(["starter", "pro", "enterprise"]),
          successUrl: z.string().url().optional(),
          cancelUrl: z.string().url().optional(),
        })
        .parse(request.body ?? {});
      const provider = getBillingProvider();
      const base = config.PUBLIC_APP_URL;
      const result = await provider.createCheckout({
        accountId: request.identity.accountId,
        planCode: body.planCode,
        successUrl: body.successUrl ?? `${base}/settings/billing?checkout=success`,
        cancelUrl: body.cancelUrl ?? `${base}/settings/billing?checkout=cancel`,
      });
      if (!result.url) {
        return reply.code(200).send({
          url: null,
          contactSupport: true,
          message: "Contact support to upgrade",
        });
      }
      return reply.code(200).send({ url: result.url, contactSupport: false });
    },
  );

  /** Public Paddle webhook — signature verified by provider. */
  app.post("/billing/webhooks/paddle", async (request, reply) => {
    const raw =
      typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body ?? {});
    const provider = getBillingProvider();
    if (provider.name !== "paddle") {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "Paddle disabled", requestId: request.id },
      });
    }
    const event = await provider.verifyWebhook(
      request.headers as Record<string, string | string[] | undefined>,
      raw,
    );
    const result = await processBillingEvent(app.database, event);
    return reply.code(200).send({ ok: true, duplicate: result.duplicate });
  });
};

export default routes;
