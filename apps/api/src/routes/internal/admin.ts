import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { register } from "prom-client";
import { config } from "../../config.js";

const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (request) => {
    const secret = request.headers["x-admin-secret"];
    if (typeof secret !== "string" || !equal(secret, config.ADMIN_API_SECRET)) throw Object.assign(new Error("Forbidden"), { statusCode: 403, code: "FORBIDDEN" });
  });
  app.get("/metrics", async (_request, reply) => reply.type(register.contentType).send(await register.metrics()));
};
export default routes;
