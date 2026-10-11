import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The render tests start Chromium; give them room on a cold CI runner.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportOnFailure: true,
      all: true,
      include: ["skills/motion-render/scripts/**/*.ts"],
      // cli.ts only wires commands to the modules; the smoke test runs it as a real process.
      exclude: ["skills/motion-render/scripts/cli.ts"],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
        perFile: false,
      },
    },
  },
});
