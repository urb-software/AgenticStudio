import { createSecretKey, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AppModule } from '../../app.module.js';
import { buildApp } from '../../app.js';
import { createOpenApiDocument } from './openapi.js';

// Offline generator for `pnpm contracts:generate`: needs no database or Redis (clients connect
// lazily, no queue worker starts). The placeholder config never connects anywhere.
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
      // No worker token: the generator serves no requests.
      workerToken: null,
      workerLeaseSeconds: 60,
      controllerToken: null,
      controllerLeaseSeconds: 60,
      previewLimits: { memoryMiB: 1024, cpuPercent: 100, tasksMax: 512, buildMinutes: 20 },
      previewLogMaxBytes: 2 * 1024 * 1024,
      previewUnclaimedMinutes: 5,
      previewMaxRunning: 3,
      runLimits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
      runLogMaxBytes: 8 * 1024 * 1024,
      runSnapshotRetentionDays: 7,
      operatorGithubLogin: null,
      mergeCredential: null,
      mergeGithubApiUrl: null,
      previewDomain: null,
      retention: {
        days: 7,
        maxPerProject: 10,
        openPullRequestIdleDays: 30,
        hoursAfterPullRequestEnd: 24,
      },
    },
    { queue: { startWorkers: false } },
  ),
  { logger: false },
);
await app.init();
const document = createOpenApiDocument(app);
await app.close();

await writeFile(resolve(outputPath), `${JSON.stringify(document, null, 2)}\n`);
