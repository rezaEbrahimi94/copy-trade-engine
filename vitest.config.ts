import { defineConfig } from 'vitest/config';

/**
 * unit:        pure domain, application services (in-memory adapters), HTTP via inject.
 * integration: real Postgres and Redpanda via Testcontainers (requires Docker).
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/{domain,application,contracts,messaging,platform}/test/**/*.test.ts',
            'apps/{api,worker}/test/unit/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            'packages/db/test/**/*.test.ts',
            'apps/{api,worker}/test/integration/**/*.test.ts',
          ],
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
        'packages/messaging/src/codec.ts',
        'packages/platform/src/{instance-id,periodic-task}.ts',
        'apps/worker/src/{config,handler,metrics}.ts',
      ],
      exclude: ['**/index.ts', 'packages/application/src/ports.ts'],
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
