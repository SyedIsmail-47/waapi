import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["**/*.test.ts"],
    // Dashboard has its own vitest (jsdom) via apps/dashboard; avoid double-running in node.
    exclude: ["**/node_modules/**", "**/dist/**", "apps/dashboard/**"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
