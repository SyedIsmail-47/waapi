import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import { redis } from "../../services/queues.js";

const routes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    try {
      await Promise.all([app.database.db.execute(sql`select 1`), redis.ping()]);
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
};
export default routes;
