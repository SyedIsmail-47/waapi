import type { Logger } from "./logger.js";

export function installShutdownHandlers(args: {
  log: Logger;
  onShutdown: () => Promise<void>;
}): void {
  let stopping = false;
  const run = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    args.log.info({ signal }, "graceful shutdown");
    try {
      await args.onShutdown();
      process.exit(0);
    } catch (err) {
      args.log.error({ err }, "shutdown failed");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void run("SIGINT"));
  process.on("SIGTERM", () => void run("SIGTERM"));
}
