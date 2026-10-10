import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts"], // process entry point; exercised by the demo, not unit tests
      reporter: ["text-summary", "text"],
      thresholds: { statements: 90, branches: 85, lines: 90 },
    },
  },
});
