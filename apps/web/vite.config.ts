import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env['API_URL'] ?? 'http://127.0.0.1:3000';
  const port = Number(env['WEB_PORT'] ?? 5173);

  return {
    plugins: [react()],
    server: {
      host: env['WEB_HOST'] ?? '127.0.0.1',
      port,
      strictPort: true,
      proxy: {
        '/api': { target: apiTarget, rewrite: (path) => path.replace(/^\/api/, '') },
      },
    },
    preview: { port, strictPort: true },
  };
});
