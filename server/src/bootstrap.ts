import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { ClipLibrary, toClipInfo } from './clips/ClipLibrary.js';
import { RoomManager } from './room/RoomManager.js';
import { ChunkStore } from './uploads/ChunkStore.js';
import { buildApp } from './http/app.js';

export interface RunningServer {
  app: FastifyInstance;
  rooms: RoomManager;
  store: ChunkStore;
  /** e.g. `http://127.0.0.1:3000` */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Builds every dependency from `config`, then listens. Used by main.ts and integration tests. */
export async function startServer(
  config: Config,
  opts: { logger?: boolean | { level: string } } = {},
): Promise<RunningServer> {
  const clips = ClipLibrary.load(config.clipsDir);
  const store = new ChunkStore(config.dataDir);
  await store.init();
  const rooms = new RoomManager({ config, clips: clips.clips.map(toClipInfo), store });
  const app = await buildApp({ config, clips, rooms, store }, opts);
  app.addHook('onClose', async () => {
    await rooms.stop();
  });
  rooms.start();
  for (const w of clips.warnings) app.log.warn(w);
  app.log.info(`clips: ${clips.size} from ${config.clipsDir}`);
  await app.listen({ port: config.port, host: config.host });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return {
    app,
    rooms,
    store,
    url: `http://${host}:${port}`,
    port,
    close: () => app.close(),
  };
}
