import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { register } from "prom-client";
import { createInviteBodySchema } from "@waapi/shared";
import { z } from "zod";
import { config } from "../../config.js";
import {
  adminCreateInvite,
  adminSetPlan,
  findUser,
  forceSessionLogout,
  listFailingWebhooks,
  listManualReview,
  revokeAllKeys,
  suspendAccount,
} from "../../services/admin-ops.js";
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

  app.get("/users", async (request) => {
    const q = z.object({ q: z.string().min(1).max(320) }).parse(request.query).q;
    return { items: await findUser(app.database, q) };
  });

  app.post<{ Params: { accountId: string } }>(
    "/accounts/:accountId/suspend",
    async (request, reply) => {
      await suspendAccount(
        app.database,
        z.string().uuid().parse(request.params.accountId),
        true,
      );
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { accountId: string } }>(
    "/accounts/:accountId/unsuspend",
    async (request, reply) => {
      await suspendAccount(
        app.database,
        z.string().uuid().parse(request.params.accountId),
        false,
      );
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { accountId: string } }>(
    "/accounts/:accountId/plan",
    async (request, reply) => {
      const accountId = z.string().uuid().parse(request.params.accountId);
      const planCode = z
        .object({ planCode: z.enum(["trial", "starter", "pro", "enterprise"]) })
        .parse(request.body).planCode;
      await adminSetPlan(app.database, accountId, planCode);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { accountId: string } }>(
    "/accounts/:accountId/revoke-keys",
    async (request, reply) => {
      await revokeAllKeys(app.database, z.string().uuid().parse(request.params.accountId));
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/sessions/:sessionId/force-logout",
    async (request, reply) => {
      await forceSessionLogout(app.database, z.string().uuid().parse(request.params.sessionId));
      return reply.code(202).send({ queued: true });
    },
  );

  app.get("/webhooks/failing", async (request) => {
    const limit = z
      .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
      .parse(request.query).limit;
    return { items: await listFailingWebhooks(app.database, limit) };
  });

  app.get("/billing/manual-review", async (request) => {
    const limit = z
      .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
      .parse(request.query).limit;
    return { items: await listManualReview(app.database, limit) };
  });

  /** Create a single-use invite code (plaintext returned once). */
  app.post("/invites", async (request, reply) => {
    const input = createInviteBodySchema.parse(request.body ?? {});
    const created = await adminCreateInvite(app.database, {
      expiresInHours: input.expiresInHours,
      note: input.note,
    });
    return reply.code(201).send({
      id: created.id,
      code: created.code,
      codePrefix: created.codePrefix,
      expiresAt: created.expiresAt.toISOString(),
    });
  });

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
