import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { ReportStore } from './db.ts';
import { startServer } from './server.ts';
import { Unifi } from './unifi.ts';

// Stamped by the Dockerfile from the commit CI built; "dev" in a checkout.
const shaFile = join(import.meta.dir, '..', 'BUILD_SHA');
const buildSha = existsSync(shaFile) ? readFileSync(shaFile, 'utf8').trim().slice(0, 12) : 'dev';

const config = loadConfig(process.env, buildSha);
const store = new ReportStore(config.databasePath);
const unifi = config.unifi ? new Unifi(config.unifi) : null;

const server = startServer({ config, store, unifi });
console.log(
  `wifi-tester ${buildSha} listening on ${server.url} as ${config.publicBaseUrls.join(', ')}; ` +
    `UniFi ${config.unifi ? `${config.unifi.host} site ${config.unifi.site}` : 'disabled'}`,
);

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    server.stop();
    store.close();
    process.exit(0);
  });
