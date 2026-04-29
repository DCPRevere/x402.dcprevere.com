import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Exclude wiring/entry and type-only modules that have no behavior to test.
      exclude: ["src/server.ts", "src/core/product.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
