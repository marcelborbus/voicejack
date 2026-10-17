import { loadConfig } from './config.js';
import { startServer } from './bootstrap.js';

const config = loadConfig();
const server = await startServer(config, { logger: { level: config.logLevel } });
server.app.log.info(`Voicejack listening on ${server.url} (timings=${config.timingsName})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    void server.close().then(() => process.exit(0));
  });
}
