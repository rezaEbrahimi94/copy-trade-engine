import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  deps: {
    // Workspace packages ship TypeScript source and are bundled; npm packages stay external.
    alwaysBundle: [/^@copy-trade\//],
    neverBundle: [/^(?!@copy-trade\/)[^./]/],
  },
});
