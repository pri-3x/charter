import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@charter/shared": resolve(__dirname, "packages/shared/src/index.ts"),
      "@charter/gate": resolve(__dirname, "packages/gate/src/index.ts"),
      "@charter/sdk": resolve(__dirname, "packages/sdk/src/index.ts"),
      "@charter/verifier": resolve(__dirname, "packages/verifier/src/verify.ts"),
    },
  },
  test: {
    globals: false,
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    // Integration tests hit a real Postgres and share a chained ledger + one seeded agent
    // (S15 suspends it); run files serially so they never interleave.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
