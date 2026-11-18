// @ts-check
/** Mutation testing for the pure domain, the application services and the worker's message handler. */
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.stryker.config.ts' },
  mutate: [
    'packages/domain/src/**/*.ts',
    'packages/application/src/**/*.ts',
    'apps/worker/src/handler.ts',
    '!**/index.ts',
    '!packages/application/src/ports.ts',
  ],
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  thresholds: { high: 95, low: 90, break: 90 },
  concurrency: 4,
  timeoutMS: 20000,
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
};
