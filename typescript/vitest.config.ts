import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      // `src/index.ts` is measured, not excluded: it is the barrel file, and
      // the barrel file is exactly where a missing or misspelt export lives.
      // `src/types.ts` stays out because it compiles to nothing - it is
      // interfaces and enums, and an enum's declaration is not a branch.
      exclude: ["src/**/*.d.ts", "src/types.ts"],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
    testTimeout: 15000,
  },
});
