import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The first test in each file pays Fastify/Ajv cold start; on a busy or freshly installed
    // machine that exceeded the 5 s default (seen once in a clean-clone run). Logic is unaffected.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts"], // process entry point; exercised by the demo, not unit tests
      reporter: ["text-summary", "text"],
      thresholds: { statements: 90, branches: 85, lines: 90 },
    },
  },
});
