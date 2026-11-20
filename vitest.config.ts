import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Build once via the tsup API so spawned-CLI tests never resolve npm from
    // the Node binary path (broken on hosted Node toolcache installations).
    globalSetup: ['./test/global-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/cli.ts', '**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.d.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 90,
      },
      reporter: ['text', 'lcov'],
    },
  },
});
