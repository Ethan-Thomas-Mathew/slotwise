import type { Server } from 'node:http';
import { loadConfig } from './config';
import { buildApp } from './app';
import { createDeps } from './deps';
import { startMetricsServer } from './lib/metrics';
import { initSentry } from './lib/sentry';

const config = loadConfig();
initSentry(config, 'api');
const { deps, close } = createDeps(config);
const app = await buildApp(deps);

let metricsServer: Server | undefined;

// Graceful shutdown: stop taking requests, finish in-flight ones, close connections.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'Shutting down');
    metricsServer?.close();
    await app.close();
    await close();
    process.exit(0);
  });
}

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  // Metrics are useful but not essential: if their port is taken, keep serving.
  metricsServer = await startMetricsServer(config.METRICS_PORT, config.METRICS_HOST).catch(
    (err: Error) => {
      app.log.warn({ err: err.message }, 'Metrics server not started');
      return undefined;
    },
  );
  if (metricsServer)
    app.log.info(
      `Metrics on ${config.METRICS_HOST}:${config.METRICS_PORT}/metrics (internal only)`,
    );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
