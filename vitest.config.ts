import { defineConfig } from 'vitest/config';

/**
 * unit:        pure domain, application services (in-memory adapters), HTTP via inject.
 * integration: real Postgres via Testcontainers (requires Docker).
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/{domain,application,contracts}/test/**/*.test.ts',
            'apps/api/test/unit/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/db/test/**/*.test.ts', 'apps/api/test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: [
        'packages/domain/src/**/*.ts',
        'packages/application/src/**/*.ts',
        'packages/contracts/src/**/*.ts',
        'apps/api/src/http/**/*.ts',
        'apps/api/src/config.ts',
        'apps/api/src/observability/metrics.ts',
        'apps/api/src/infrastructure/**/*.ts',
      ],
      exclude: [
        '**/index.ts',
        'packages/application/src/ports.ts',
        'apps/api/src/infrastructure/system.ts',
      ],
      thresholds: {
        'packages/domain/src/**': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'packages/application/src/**': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
      },
    },
  },
});
