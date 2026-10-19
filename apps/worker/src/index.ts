import { createBaileysClient } from "./baileys/baileys-client.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { startSendTextWorker } from "./jobs/send-text.js";
import { createLogger } from "./logger.js";
import { SessionMetrics } from "./metrics.js";
import { subscribeWorkerCommands } from "./redis/commands.js";
import { createRedis } from "./redis/pubsub.js";
import { SessionManager } from "./session/manager.js";
import { installShutdownHandlers } from "./shutdown.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  const { db, client } = createDb(cfg.databaseUrl);
  const redis = createRedis(cfg.redisUrl);
  const metrics = new SessionMetrics();
  const metricsServer = metrics.startServer(cfg.workerMetricsPort);

  const manager = new SessionManager(
    db,
    redis,
    cfg,
    log,
    async ({ sessionId, accountId }) =>
      createBaileysClient({ sessionId, accountId, db, cfg, log }),
    metrics,
  );

  subscribeWorkerCommands({ redis, manager, log });

  const sendWorker = startSendTextWorker({
    connection: redis.duplicate(),
    db,
    manager,
    log,
  });

  await manager.loadOnBoot();
  log.info(
    {
      brand: cfg.brandName,
      maxSessionsPerNode: cfg.maxSessionsPerNode,
      metricsPort: cfg.workerMetricsPort,
    },
    "worker started",
  );

  installShutdownHandlers({
    log,
    onShutdown: async () => {
      await sendWorker.close();
      await manager.shutdown();
      metricsServer.close();
      await redis.quit();
      await client.end({ timeout: 5 });
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
