import { buildApp, buildInternalApp } from "./app.js";
import { config } from "./config.js";
import { startEmailWorker } from "./services/email.js";

async function main(): Promise<void> {
  const app = await buildApp();
  const emailWorker = startEmailWorker();
  const internal = await buildInternalApp(app.database);

  app.addHook("onClose", async () => {
    await emailWorker.close();
    await internal.close();
  });

  // Production: internal admin stays on loopback. Smoke/e2e publishes :3001 and
  // must bind 0.0.0.0 so Docker port mapping can reach the internal app.
  const internalHost =
    config.SMOKE_MODE || config.NODE_ENV === "test" ? "0.0.0.0" : "127.0.0.1";
  await Promise.all([
    app.listen({ host: "0.0.0.0", port: config.API_PORT }),
    internal.listen({ host: internalHost, port: config.INTERNAL_PORT }),
  ]);
  app.log.info(
    { apiPort: config.API_PORT, internalPort: config.INTERNAL_PORT, internalHost },
    "api listening",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
