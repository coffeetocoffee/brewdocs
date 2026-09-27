import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Tests run against workspace *source*, not the published dist bundles that
// `@brewdocs/core`'s exports map points at (finding #8). Keeps tests honest
// about what is actually being changed.
const core = fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url));
const sdk = fileURLToPath(new URL("./packages/plugin-sdk/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@brewdocs/core": core,
      "@brewdocs/plugin-sdk": sdk,
    },
  },
  test: {
    include: ["packages/**/*.test.ts"],
    environment: "node",
    // Several tests shell out (npm/tsc/git) via blocking sync calls and take
    // 20-30s. Vitest 4 enforces the timeout where 2 could not while the event
    // loop was blocked, so the slow end needs an explicit budget.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
