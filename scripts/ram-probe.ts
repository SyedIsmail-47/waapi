import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
loadDotenv({ path: resolve(root, ".env") });

/**
 * Measures process RSS while simulating N in-memory session slots.
 * For a live connected session, start the worker separately and compare RSS.
 * Document results in docs/runbook.md to set MAX_SESSIONS_PER_NODE.
 */
async function main(): Promise<void> {
  const counts = [0, 1, 3, 5, 10];
  const results: Array<{ sessions: number; rssBytes: number; rssMb: number }> = [];

  for (const n of counts) {
    const slots = Array.from({ length: n }, (_, i) => ({
      id: `probe-${i}`,
      buffers: [Buffer.alloc(256 * 1024), Buffer.alloc(256 * 1024)],
    }));
    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 200));
    const rss = process.memoryUsage().rss;
    results.push({ sessions: n, rssBytes: rss, rssMb: Math.round((rss / 1024 / 1024) * 10) / 10 });
    void slots;
  }

  console.log(JSON.stringify({ probe: "in-memory-session-slots", results }, null, 2));
  console.log(
    "Also record RSS with worker running 0 sockets vs 1 connected session for a real cap estimate.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
