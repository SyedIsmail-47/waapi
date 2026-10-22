import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { register } from "prom-client";
import { z } from "zod";
import { config } from "../../config.js";
import { redis } from "../../services/queues.js";

/** Must match apps/worker fake-control-bus channel. */
const FAKE_CONTROL_CHANNEL = "waapi:fake:control";

const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (request) => {
    const secret = request.headers["x-admin-secret"];
    if (typeof secret !== "string" || !equal(secret, config.ADMIN_API_SECRET)) {
      throw Object.assign(new Error("Forbidden"), { statusCode: 403, code: "FORBIDDEN" });
    }
  });
  app.get("/metrics", async (_request, reply) =>
    reply.type(register.contentType).send(await register.metrics()),
  );

  /** Fake WA driver controls — only meaningful when worker WA_DRIVER=fake. */
  app.post<{ Params: { sessionId: string } }>(
    "/fake/sessions/:sessionId/scan",
    async (request, reply) => {
      const sessionId = z.string().uuid().parse(request.params.sessionId);
      const body = z
        .object({ phoneNumber: z.string().min(5).max(32).optional() })
        .parse(request.body ?? {});
      await redis.publish(
        FAKE_CONTROL_CHANNEL,
        JSON.stringify({ op: "scan", sessionId, phoneNumber: body.phoneNumber }),
      );
      return reply.code(202).send({ queued: true });
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/fake/sessions/:sessionId/inbound",
    async (request, reply) => {
      const sessionId = z.string().uuid().parse(request.params.sessionId);
      const body = z
        .object({
          remoteJid: z.string().min(5).max(128),
          text: z.string().max(4096).optional(),
        })
        .parse(request.body);
      await redis.publish(
        FAKE_CONTROL_CHANNEL,
        JSON.stringify({
          op: "inbound",
          sessionId,
          remoteJid: body.remoteJid,
          text: body.text,
        }),
      );
      return reply.code(202).send({ queued: true });
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/fake/sessions/:sessionId/ban",
    async (request, reply) => {
      const sessionId = z.string().uuid().parse(request.params.sessionId);
      await redis.publish(FAKE_CONTROL_CHANNEL, JSON.stringify({ op: "ban", sessionId }));
      return reply.code(202).send({ queued: true });
    },
  );
};
export default routes;
