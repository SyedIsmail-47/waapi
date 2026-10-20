import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { createDb } from "@waapi/db";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { config } from "./config.js";
import authPlugin from "./plugins/auth.js";
import errorHandler from "./plugins/error-handler.js";
import rateLimit from "./plugins/rate-limit.js";
import requestId from "./plugins/request-id.js";
import authRoutes from "./routes/v1/auth.js";
import healthRoutes from "./routes/v1/health.js";
import messageRoutes from "./routes/v1/messages.js";
import sendRoutes from "./routes/v1/send.js";
import sessionRoutes from "./routes/v1/sessions.js";
import webhookRoutes from "./routes/v1/webhooks.js";
import { closeQueues } from "./services/queues.js";
import { purgeAuthArtifacts } from "./services/auth.js";
import "./types.js";

export type BuiltApp = FastifyInstance & {
  registeredRoutes: Array<{ method: string; url: string }>;
};

export async function buildApp(): Promise<BuiltApp> {
  const app = Fastify({
    // Numeric hop count (default 1). Boolean `true` would trust the entire chain.
    trustProxy: config.TRUST_PROXY_HOPS as unknown as boolean,
    logger:
      config.NODE_ENV === "development"
        ? { level: config.LOG_LEVEL, transport: { target: "pino-pretty" } }
        : { level: config.LOG_LEVEL },
    genReqId: (request) => {
      const supplied = request.headers["x-request-id"];
      return typeof supplied === "string" && supplied.length <= 128
        ? supplied
        : crypto.randomUUID();
    },
  }) as unknown as BuiltApp;

  const registeredRoutes: Array<{ method: string; url: string }> = [];
  app.decorate("registeredRoutes", registeredRoutes);
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      registeredRoutes.push({ method, url: route.url });
    }
  });

  const database = createDb(config.DATABASE_URL);
  app.decorate("database", database);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cors, { origin: false });
  await app.register(sensible);

  if (config.ENABLE_DOCS) {
    const [{ default: swagger }, { jsonSchemaTransform }, swaggerUi] = await Promise.all([
      import("@fastify/swagger"),
      import("fastify-type-provider-zod"),
      import("@fastify/swagger-ui"),
    ]);
    await app.register(swagger, {
      openapi: { info: { title: `${config.BRAND_NAME} API`, version: "1.0.0" } },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi.default, { routePrefix: "/docs" });
    app.get("/openapi.json", async () => app.swagger());
  }

  await app.register(requestId);
  await app.register(errorHandler);
  await app.register(rateLimit);
  await app.register(authPlugin);
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(sessionRoutes, { prefix: "/api/v1/sessions" });
  await app.register(sendRoutes, { prefix: "/api/v1" });
  await app.register(messageRoutes, { prefix: "/api/v1/messages" });
  await app.register(webhookRoutes, { prefix: "/api/v1/sessions" });

  const purgeTimer = setInterval(() => {
    void purgeAuthArtifacts(database).catch(() => undefined);
  }, 60 * 60_000);
  purgeTimer.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(purgeTimer);
    await closeQueues();
    await database.client.end();
  });
  return app;
}

export async function buildInternalApp(
  database: ReturnType<typeof createDb>,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    trustProxy: false,
  });
  app.decorate("database", database);
  const adminRoutes = await import("./routes/internal/admin.js");
  await app.register(adminRoutes.default, { prefix: "/internal/admin" });
  return app;
}
