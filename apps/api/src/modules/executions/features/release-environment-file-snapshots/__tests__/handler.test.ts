import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RUN_ENVIRONMENT_FILE_ORPHAN_AGE_MS,
  RUN_ENVIRONMENT_FILE_SECRET_OWNER,
} from '../../../domain/entities/run-environment-file.js';
import { lostWorkerRule } from '../../../domain/entities/run.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { InMemorySecretStore } from '../../../ports/__tests__/in-memory-secret-store.js';
import { ReleaseEnvironmentFileSnapshotsHandler } from '../handler.js';

// Issue #104: a Run's Environment file snapshot serves its log redaction while the Run goes
// on, and is deleted once the Run is final, however it ended. Test values only.

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OTHER = '4a3c9d2f-5e6b-4c7d-8e9f-0a1b2c3d4e5f';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const OWNER = { owner: RUN_ENVIRONMENT_FILE_SECRET_OWNER };

describe('Environment file snapshots', () => {
  let runs: InMemoryRunRepository;
  let secrets: InMemorySecretStore;
  let release: ReleaseEnvironmentFileSnapshotsHandler;

  async function claimedWithSnapshot(projectId: string, content: string) {
    await runs.add({
      projectId,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      integrationBranch: 'dev',
    });
    const run = (await runs.claimNext(WORKER, T0))!;
    const snapshot = await secrets.put(content, OWNER);
    await runs.attachEnvironmentFile(run.id, WORKER, { path: '.env', secretRef: snapshot });
    return { runId: run.id, snapshot };
  }

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    runs = new InMemoryRunRepository();
    secrets = new InMemorySecretStore();
    release = new ReleaseEnvironmentFileSnapshotsHandler(runs, secrets);
  });

  afterEach(() => vi.restoreAllMocks());

  it("deletes the snapshots of Runs that ended any way, e.g. a lost worker, and keeps the others'", async () => {
    const lost = await claimedWithSnapshot(PROJECT, 'A=test-only-lost');
    const { staleBefore, failure } = lostWorkerRule(new Date(T0.getTime() + 61_000), 60);
    await runs.failStaleClaims(staleBefore, failure, failure, T0);
    const live = await claimedWithSnapshot(OTHER, 'B=test-only-live');

    await release.releaseFinal();

    expect(secrets.values.has(lost.snapshot)).toBe(false);
    expect(await runs.findEnvironmentFileSecret(lost.runId)).toBeNull();
    expect(secrets.values.has(live.snapshot)).toBe(true);
  });

  it('deletes snapshots no Run references once they are an hour old', async () => {
    const kept = await claimedWithSnapshot(PROJECT, 'A=test-only-kept');
    const orphan = await secrets.put('B=test-only-orphan', OWNER);
    const otherOwner = await secrets.put('key', { owner: 'projects.deploy-key' });
    secrets.now += RUN_ENVIRONMENT_FILE_ORPHAN_AGE_MS;
    const young = await secrets.put('C=test-only-young', OWNER);

    await release.releaseFinal();

    expect([...secrets.values.keys()].sort()).toEqual([kept.snapshot, otherOwner, young].sort());
    expect(secrets.values.has(orphan)).toBe(false);
  });

  it('never throws when the store is unavailable', async () => {
    const { runId } = await claimedWithSnapshot(PROJECT, 'A=test-only-value');
    secrets.failWith = new Error('down');

    await expect(release.releaseFinal()).resolves.toBeUndefined();
    await expect(release.releaseFor(runId)).resolves.toBeUndefined();
  });
});
