import { loadConfig } from './config';
import { buildApp } from './app';

const config = loadConfig();
const app = await buildApp({ config });

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
