import { createApp } from './server.js';
import { StoreRegistry } from './store.js';
import { RunManager } from './runs.js';
import { photoRoutes } from './photos.js';
import { chatRoutes } from './chat.js';
import { sweepPhotos, startSweeper } from './sweep.js';

// Wires the pieces together. Identity and the gateway client are injected: production passes the
// Cloudflare Access authenticator and the socket client, tests pass their own.
export function buildService({ config, authenticate, gateway, logger, now }) {
  const stores = new StoreRegistry({
    dataDir: config.dataDir,
    userIds: config.userIds,
    tzName: config.tzName,
    now,
  });
  const runs = new RunManager({ config, stores, gateway, logger, now });
  runs.resetOrphans();
  const server = createApp({
    config,
    authenticate,
    stores,
    logger,
    routes: [...photoRoutes({ config }), ...chatRoutes({ runs })],
    isBusy: (user) => runs.isBusy(user),
  });
  const stopSweeper = startSweeper({
    sweep: () =>
      sweepPhotos({
        dataDir: config.dataDir,
        userIds: config.userIds,
        ttlMs: config.photoTtlHours * 3600 * 1000,
        stagedTtlMs: config.stagedPhotoTtlMinutes * 60 * 1000,
        activeRunIds: runs.activeRunIds(),
      }),
  });
  return {
    server,
    runs,
    stores,
    close() {
      stopSweeper();
      stores.closeAll();
    },
  };
}
