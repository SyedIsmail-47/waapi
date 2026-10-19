import { getBrandName } from "@waapi/shared";

/**
 * Phase 1 stub. Full Fastify /api/v1 lands in Phase 2.
 * API must never hold Baileys sockets.
 */
async function main(): Promise<void> {
  const brand = getBrandName();
  console.log(
    JSON.stringify({
      service: "api",
      brand,
      status: "stub",
      message: "API not implemented in Phase 1",
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
