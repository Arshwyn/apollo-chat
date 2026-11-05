import { loadConfig } from './config.js';
import { makeVerifier, makeAuthenticator } from './auth.js';
import { createGatewayClient } from './gatewayClient.js';
import { makeLogger } from './log.js';
import { buildService } from './service.js';

const config = loadConfig();
const logger = makeLogger();
const authenticate = makeAuthenticator({
  verify: makeVerifier({ teamDomain: config.cfTeamDomain, audience: config.cfAud }),
  users: config.users,
});
const gateway = createGatewayClient({ socketPath: config.socketPath });
const service = buildService({ config, authenticate, gateway, logger });

service.server.listen(config.port, () => logger.event('listening', { port: config.port }));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    service.server.close(() => {
      service.close();
      process.exit(0);
    });
    service.server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
