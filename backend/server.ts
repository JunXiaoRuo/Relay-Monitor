import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import { config } from './config.js';

let app: FastifyInstance;
let closing = false;
let restartRequested = false;

async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'Stopping Relay Monitor');
  const forcedExit = setTimeout(() => {
    app.log.error('Graceful shutdown timed out');
    process.exit(1);
  }, 25_000);
  forcedExit.unref();
  try {
    await app.close();
    clearTimeout(forcedExit);
    process.exit(restartRequested ? 75 : 0);
  } catch (error) {
    app.log.error({ err: error }, 'Graceful shutdown failed');
    process.exit(1);
  }
}

function requestManagedRestart(): void {
  if (closing) return;
  restartRequested = true;
  void shutdown('server_access_settings');
}

app = await buildApp({
  ...(config.isProduction && config.managedRestart ? { requestRestart: requestManagedRestart } : {}),
});

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info({ address }, 'Relay Monitor is ready');
} catch (error) {
  app.log.fatal({ err: error }, 'Relay Monitor failed to start');
  await app.close();
  process.exit(1);
}
