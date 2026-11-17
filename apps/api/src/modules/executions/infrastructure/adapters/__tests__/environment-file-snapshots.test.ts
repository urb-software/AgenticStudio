import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RUN_ENVIRONMENT_FILE_ORPHAN_AGE_MS,
  RUN_ENVIRONMENT_FILE_SECRET_OWNER,
} from '../../../domain/value-objects/run-environment-file.js';
import { lostWorkerRule } from '../../../domain/entities/run.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { InMemorySecretStore } from '../../../application/ports/__tests__/in-memory-secret-store.js';
import { SecretStoreEnvironmentFileSnapshots } from '../environment-file-snapshots.js';

// Issue #104: a Run's Environment file snapshot serves its log redaction while the Run goes
// on, and is deleted once the Run is final, however it ended. Test values only.

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OTHER = '4a3c9d2f-5e6b-4c7d-8e9f-0a1b2c3d4e5f';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const OWNER = { owner: RUN_ENVIRONMENT_FILE_SECRET_OWNER };

describe('Environment file snapshots', () => {
  let runs: InMemoryRunRepository;
  let secrets: InMemorySecretStore;
  let release: SecretStoreEnvironmentFileSnapshots;
  let now: Date;

  async function claimedWithSnapshot(projectId: string, content: string) {
    await runs.add({
      projectId,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      integrationBranch: 'dev',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
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
    now = T0;
    release = new SecretStoreEnvironmentFileSnapshots(
      runs,
      secrets,
      { now: () => now },
      { retentionDays: 7 },
    );
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

  it('keeps the snapshot of a failed delivery that can be retried, for the retention period (#125 review)', async () => {
    const run = await claimedWithSnapshot(PROJECT, 'A=test-only-retry');
    for (const [from, to] of [
      ['preparing', 'running'],
      ['running', 'failed'],
    ] as const) {
      await runs.transitionClaimed({
        runId: run.runId,
        workerId: WORKER,
        from,
        to,
        failure: to === 'failed' ? { code: 'delivery_failed', detail: 'refused' } : null,
        cancelRequested: false,
        now: T0,
      });
    }

    now = new Date(T0.getTime() + 6 * DAY);
    await release.releaseFinal();
    expect(secrets.values.has(run.snapshot)).toBe(true);

    // A retry in progress keeps it even past the period.
    await runs.requestDeliveryRetry(run.runId);
    now = new Date(T0.getTime() + 8 * DAY);
    await release.releaseFinal();
    expect(secrets.values.has(run.snapshot)).toBe(true);
  });

  it('deletes the snapshot of a retryable failed delivery once the retention period is over', async () => {
    const run = await claimedWithSnapshot(PROJECT, 'A=test-only-retry');
    for (const [from, to] of [
      ['preparing', 'running'],
      ['running', 'failed'],
    ] as const) {
      await runs.transitionClaimed({
        runId: run.runId,
        workerId: WORKER,
        from,
        to,
        failure: to === 'failed' ? { code: 'delivery_failed', detail: 'refused' } : null,
        cancelRequested: false,
        now: T0,
      });
    }

    now = new Date(T0.getTime() + 7 * DAY + 1);
    await release.releaseFinal();

    expect(secrets.values.has(run.snapshot)).toBe(false);
  });

  it('never throws when the store is unavailable', async () => {
    const { runId } = await claimedWithSnapshot(PROJECT, 'A=test-only-value');
    secrets.failWith = new Error('down');

    await expect(release.releaseFinal()).resolves.toBeUndefined();
    await expect(release.releaseFor(runId)).resolves.toBeUndefined();
  });
});
