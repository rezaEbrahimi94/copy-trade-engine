import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/main.ts', 'src/instrumentation.ts', 'src/jobs/reconcile.ts', 'src/jobs/migrate.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  deps: {
    // Workspace packages ship TypeScript source and are bundled; every npm package stays
    // external and is installed from this app's package.json in the runtime image.
    alwaysBundle: [/^@copy-trade\//],
    neverBundle: [/^(?!@copy-trade\/)[^./]/],
  },
});
