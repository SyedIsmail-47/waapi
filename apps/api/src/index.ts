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

  await Promise.all([
    app.listen({ host: "0.0.0.0", port: config.API_PORT }),
    internal.listen({ host: "127.0.0.1", port: config.INTERNAL_PORT }),
  ]);
  app.log.info(
    { apiPort: config.API_PORT, internalPort: config.INTERNAL_PORT },
    "api listening (internal bound to loopback)",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
