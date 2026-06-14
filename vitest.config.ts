import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 30_000,
    include: ["test/**/*.test.ts"],
    exclude: ["test/SignalRegistry.test.ts"],
  },
});
