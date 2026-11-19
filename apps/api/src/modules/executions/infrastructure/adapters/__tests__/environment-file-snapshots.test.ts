import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_ENVIRONMENT_FILE_SECRET_OWNER } from '../../../domain/value-objects/run-environment-file.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { InMemorySecretStore } from '../../../application/ports/__tests__/in-memory-secret-store.js';
import { SecretStoreEnvironmentFileSnapshots } from '../environment-file-snapshots.js';

// Test values only.

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const OWNER = { owner: RUN_ENVIRONMENT_FILE_SECRET_OWNER };

describe('Environment file snapshots', () => {
  let runs: InMemoryRunRepository;
  let secrets: InMemorySecretStore;
  let release: SecretStoreEnvironmentFileSnapshots;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    runs = new InMemoryRunRepository();
    secrets = new InMemorySecretStore();
    release = new SecretStoreEnvironmentFileSnapshots(runs, secrets);
  });

  afterEach(() => vi.restoreAllMocks());

  it("deletes one Run's snapshot and its reference, never throwing when the store is down", async () => {
    await runs.start({
      projectId: PROJECT,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      integrationBranch: 'dev',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
    });
    const run = (await runs.claimNext(WORKER, T0))!;
    const snapshot = await secrets.put('A=test-only-value', OWNER);
    await runs.attachEnvironmentFile(run.id, WORKER, { path: '.env', secretRef: snapshot });

    secrets.failWith = new Error('down');
    await expect(release.releaseFor(run.id)).resolves.toBeUndefined();
    expect(secrets.values.has(snapshot)).toBe(true);

    secrets.failWith = undefined;
    await release.releaseFor(run.id);

    expect(secrets.values.has(snapshot)).toBe(false);
    expect(await runs.findEnvironmentFileSecret(run.id)).toBeNull();
  });
});
