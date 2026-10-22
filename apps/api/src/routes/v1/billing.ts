import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import {
  getBillingProvider,
  getBillingSnapshot,
  processBillingEvent,
} from "../../services/billing/index.js";

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

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

  /**
   * Paddle webhook — isolated content-type parser so we keep the exact raw Buffer
   * for signature verification (never JSON.stringify of a parsed object).
   */
  await app.register(async (paddle) => {
    paddle.removeAllContentTypeParsers();
    paddle.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (req, body, done) => {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
        (req as RawBodyRequest).rawBody = buf;
        try {
          const json = JSON.parse(buf.toString("utf8")) as unknown;
          done(null, json);
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    paddle.post("/billing/webhooks/paddle", async (request, reply) => {
      const provider = getBillingProvider();
      if (provider.name !== "paddle") {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Paddle disabled", requestId: request.id },
        });
      }
      const rawBuf = (request as RawBodyRequest).rawBody;
      if (!rawBuf || !Buffer.isBuffer(rawBuf)) {
        return reply.code(401).send({
          error: { code: "UNAUTHORIZED", message: "Unauthorized", requestId: request.id },
        });
      }
      const rawBody = rawBuf.toString("utf8");
      try {
        const event = await provider.verifyWebhook(
          request.headers as Record<string, string | string[] | undefined>,
          rawBody,
        );
        const result = await processBillingEvent(app.database, event);
        return reply.code(200).send({ ok: true, duplicate: result.duplicate });
      } catch (err) {
        const status =
          err && typeof err === "object" && "statusCode" in err
            ? Number((err as { statusCode: number }).statusCode)
            : 401;
        if (status === 401) {
          return reply.code(401).send({
            error: { code: "UNAUTHORIZED", message: "Unauthorized", requestId: request.id },
          });
        }
        throw err;
      }
    });
  });
};

export default routes;
