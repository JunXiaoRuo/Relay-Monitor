import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';

function configuredPort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

export default defineConfig(({ mode }) => {
  const environment = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const webHost = environment.RELAY_WEB_HOST?.trim() || environment.HOST?.trim() || '0.0.0.0';
  const webPort = configuredPort(environment.RELAY_WEB_PORT, 5173);
  const apiPort = configuredPort(environment.RELAY_API_PORT ?? environment.PORT, 8080);
  const apiTarget = `http://127.0.0.1:${apiPort}`;

  return {
    root: 'frontend',
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./frontend/src', import.meta.url)),
        '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      },
    },
    build: {
      outDir: '../dist/web',
      emptyOutDir: true,
      sourcemap: true,
    },
    server: {
      host: webHost,
      port: webPort,
      strictPort: true,
      proxy: {
        '/api': apiTarget,
        '/healthz': apiTarget,
        '/readyz': apiTarget,
        '/openapi.json': apiTarget,
      },
    },
  };
});
