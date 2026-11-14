import { createSecretKey, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AppModule } from '../../app.module.js';
import { buildApp } from '../../app.js';
import { createOpenApiDocument } from './openapi.js';

// Offline generator for `pnpm contracts:generate`: builds the app without listening
// and without a database or Redis (both clients connect lazily, and no queue worker starts),
// then writes the document.
// The placeholder config is never used to connect anywhere.
const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error('Usage: node dist/platform/openapi/generate.js <output.json>');
}

const app = await buildApp(
  AppModule.register(
    {
      apiPort: 0,
      apiHost: '127.0.0.1',
      apiOrigin: 'http://localhost:3001',
      apiTrustedProxies: [],
      databaseUrl: 'postgresql://offline:offline@127.0.0.1:1/offline',
      redisUrl: 'redis://127.0.0.1:1',
      studioOrigin: 'http://localhost:3000',
      // Never verified against: the generator serves no requests.
      operatorPasswordHash: '$argon2id$v=19$m=19456,t=2,p=1$b2ZmbGluZQ$b2ZmbGluZQ',
      // A throwaway key: the generator stores and reads no secrets.
      secretsKey: createSecretKey(randomBytes(32)),
      // Nothing is cloned: the generator runs no Git operation.
      dataDir: tmpdir(),
      gitAllowFileRemotes: false,
      gitAllowPrivateRemotes: false,
      sshKnownHosts: [],
    },
    { queue: { startWorkers: false } },
  ),
  { logger: false },
);
await app.init();
const document = createOpenApiDocument(app);
await app.close();

await writeFile(resolve(outputPath), `${JSON.stringify(document, null, 2)}\n`);
