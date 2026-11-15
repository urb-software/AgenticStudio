import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENVIRONMENT_FILE_SECRET_OWNER } from '../../../domain/entities/environment-file.js';
import { InMemoryEnvironmentFileRepository } from '../../../domain/repositories/__tests__/in-memory-environment-file-repository.js';
import { InMemorySecretStore } from '../../deploy-key/__tests__/in-memory-secret-store.js';
import { SweepOrphanedEnvironmentFilesHandler } from '../handler.js';

// Issue #104: Environment file contents nothing references are deleted after the grace period;
// referenced ones and other modules' secrets are never touched.

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const HOUR = 60 * 60 * 1000;

describe('SweepOrphanedEnvironmentFilesHandler', () => {
  let secrets: InMemorySecretStore;
  let files: InMemoryEnvironmentFileRepository;
  let sweep: SweepOrphanedEnvironmentFilesHandler;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    secrets = new InMemorySecretStore();
    files = new InMemoryEnvironmentFileRepository();
    sweep = new SweepOrphanedEnvironmentFilesHandler(files, secrets, { gracePeriodMs: HOUR });
  });

  afterEach(() => vi.restoreAllMocks());

  it('deletes only unreferenced Environment file contents older than the grace period', async () => {
    const owner = { owner: ENVIRONMENT_FILE_SECRET_OWNER };
    const referenced = await secrets.put('A=test-only-1', owner);
    const orphan = await secrets.put('B=test-only-2', owner);
    const deployKey = await secrets.put('key', { owner: 'projects.deploy-key' });
    await files.save(PROJECT, { path: '.env', sizeBytes: 13, secretRef: referenced });
    secrets.now += HOUR;
    const fresh = await secrets.put('C=test-only-3', owner);

    await sweep.sweep();

    expect([...secrets.values.keys()].sort()).toEqual([referenced, deployKey, fresh].sort());
    expect(secrets.values.has(orphan)).toBe(false);
  });

  it('never throws when the store is unavailable', async () => {
    secrets.failWith = new Error('down');
    await expect(sweep.sweep()).resolves.toBeUndefined();
  });
});
