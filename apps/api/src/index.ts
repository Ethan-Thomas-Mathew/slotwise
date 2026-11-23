import { loadConfig } from './config';
import { buildApp } from './app';
import { createDeps } from './deps';
import { initSentry } from './lib/sentry';

const config = loadConfig();
initSentry(config, 'api');
const { deps, close } = createDeps(config);
const app = await buildApp(deps);

// Graceful shutdown: stop taking requests, finish in-flight ones, close connections.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    await close();
    process.exit(0);
  });
}

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
