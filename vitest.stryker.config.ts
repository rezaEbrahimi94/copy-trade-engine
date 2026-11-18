import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/domain/test/**/*.test.ts',
      'packages/application/test/**/*.test.ts',
      'apps/worker/test/unit/handler.test.ts',
    ],
    environment: 'node',
  },
});
