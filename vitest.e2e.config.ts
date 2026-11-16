import { defineConfig } from "vitest/config";

// Live tests against a real server. Kept out of vitest.config.ts so `pnpm test` and its coverage
// floor never need Docker.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["e2e/**/*.test.ts"],
    globalSetup: ["e2e/global-setup.ts"],
    // Pulling images and starting two containers happens in globalSetup, not per test.
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // One server, and a shared table: files take turns.
    fileParallelism: false,
  },
});
