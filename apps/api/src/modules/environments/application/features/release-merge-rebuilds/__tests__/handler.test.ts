import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewMergeRebuild } from '../../../../domain/entities/preview-merge-rebuild.js';
import { PreviewOperation } from '../../../../domain/entities/preview-operation.js';
import { InMemoryPreviewMergeRebuildRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-merge-rebuild-repository.js';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { InMemoryPreviewSettingsRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-settings-repository.js';
import { COMMIT, FakePreviewSources } from '../../../ports/__tests__/fake-preview-sources.js';
import {
  KIT_NOW as NOW,
  previewBuildRequests,
  savePreviewSettings,
  seedBuild,
} from '../../../__tests__/preview-test-kit.js';
import { ReleaseMergeRebuildsHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const RUN = '3c1d8f2a-0b2f-4d6e-8a44-6b3c1d8f2a10';
const RUNNING = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';
const SECOND = '1c3a7e63-4e1c-4e7f-9b55-7c4d2e9a3b21';
const OLD = 'a'.repeat(40);
const MERGED = COMMIT;
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);

describe('ReleaseMergeRebuildsHandler', () => {
  let sources: FakePreviewSources;
  let settings: InMemoryPreviewSettingsRepository;
  let operations: InMemoryPreviewOperationRepository;
  let rebuilds: InMemoryPreviewMergeRebuildRepository;
  let handler: ReleaseMergeRebuildsHandler;

  function arrange(now: Date = NOW) {
    const kit = previewBuildRequests(operations, sources, settings, { now });
    handler = new ReleaseMergeRebuildsHandler(
      rebuilds,
      sources,
      settings,
      operations,
      kit.clock,
      kit.requests,
    );
    return kit;
  }

  beforeEach(async () => {
    sources = new FakePreviewSources();
    settings = new InMemoryPreviewSettingsRepository();
    operations = new InMemoryPreviewOperationRepository();
    rebuilds = new InMemoryPreviewMergeRebuildRepository();
    await savePreviewSettings(settings, PROJECT);
    await seedBuild(operations, PROJECT, RUNNING, 'succeeded', minutes(-10), OLD);
    sources.statusAnswer = { status: 'ready', commit: MERGED, fetchedAt: minutes(0.5) };
    arrange();
  });

  const record = (projectId = PROJECT, at = NOW) =>
    rebuilds.save(
      PreviewMergeRebuild.record({
        projectId,
        runId: RUN,
        mergedCommit: MERGED,
        mergedAt: at,
        fetchStartedAt: new Date(at.getTime() + 1000),
        now: at,
      }),
    );
  const builds = () =>
    [...operations.operations.values()].filter(
      (operation) => operation.kind === 'build' && operation.id !== RUNNING,
    );

  it('builds the Clone commit for a recorded merge, started by the Run, and deletes the row', async () => {
    await record();

    const result = await handler.execute();

    expect(result).toEqual({ built: 1, dropped: 0, failed: 0 });
    expect(builds()).toHaveLength(1);
    expect(builds()[0]).toMatchObject({ projectId: PROJECT, status: 'requested' });
    expect(builds()[0]!.build).toMatchObject({ commit: MERGED, startedByRunId: RUN });
    expect(await rebuilds.find(PROJECT)).toBeNull();
  });

  it('builds only for a recorded rebuild: with none recorded it starts nothing', async () => {
    await expect(handler.execute()).resolves.toEqual({ built: 0, dropped: 0, failed: 0 });
    expect(builds()).toEqual([]);
  });

  it('waits while the Clone does not hold the merge yet, and builds when it does', async () => {
    await record();
    sources.statusAnswer = { status: 'ready', commit: OLD, fetchedAt: minutes(-5) };

    await expect(handler.execute()).resolves.toEqual({ built: 0, dropped: 0, failed: 0 });
    expect(builds()).toEqual([]);
    expect(await rebuilds.find(PROJECT)).not.toBeNull();

    sources.statusAnswer = { status: 'ready', commit: MERGED, fetchedAt: minutes(1) };
    await expect(handler.execute()).resolves.toMatchObject({ built: 1 });
  });

  it('waits while a build is active and does not queue a second one', async () => {
    await record();
    await seedBuild(operations, PROJECT, SECOND, 'claimed', minutes(1), OLD);

    await expect(handler.execute()).resolves.toEqual({ built: 0, dropped: 0, failed: 0 });

    expect(builds()).toHaveLength(1);
    expect(await rebuilds.find(PROJECT)).not.toBeNull();
  });

  it('drops the rebuild when the Preview already runs the Clone commit', async () => {
    await record();
    sources.statusAnswer = { status: 'ready', commit: OLD, fetchedAt: minutes(1) };

    await expect(handler.execute()).resolves.toEqual({ built: 0, dropped: 1, failed: 0 });

    expect(builds()).toEqual([]);
    expect(await rebuilds.find(PROJECT)).toBeNull();
  });

  it('drops the rebuild when the Preview is no longer running', async () => {
    await record();
    await operations.add(
      PreviewOperation.requestOther({
        id: SECOND,
        projectId: PROJECT,
        kind: 'stop',
        now: minutes(2),
      }),
    );
    await operations.change(SECOND, (operation) => {
      operation.claim(RUNNING, minutes(2));
      operation.succeed(RUNNING, null, minutes(3));
    });

    await expect(handler.execute()).resolves.toEqual({ built: 0, dropped: 1, failed: 0 });

    expect(builds()).toEqual([]);
  });

  it('gives up 30 minutes after the recording, with the reason, and keeps the failed row', async () => {
    await record();
    sources.statusAnswer = { status: 'ready', commit: OLD, fetchedAt: minutes(-5) };
    arrange(minutes(31));

    await expect(handler.execute()).resolves.toEqual({ built: 0, dropped: 0, failed: 1 });

    const failed = await rebuilds.find(PROJECT);
    expect(failed?.isFailed).toBe(true);
    expect(failed?.failure).toContain('did not start within 30 minutes');
    await expect(handler.execute()).resolves.toEqual({ built: 0, dropped: 0, failed: 0 });
    expect(await rebuilds.find(PROJECT)).not.toBeNull();
  });

  it('removes a failed rebuild once a newer build was requested', async () => {
    await record();
    sources.statusAnswer = { status: 'ready', commit: OLD, fetchedAt: minutes(-5) };
    arrange(minutes(31));
    await handler.execute();
    await seedBuild(operations, PROJECT, SECOND, 'succeeded', minutes(40), MERGED);
    arrange(minutes(45));

    await expect(handler.execute()).resolves.toEqual({ built: 0, dropped: 1, failed: 0 });

    expect(await rebuilds.find(PROJECT)).toBeNull();
  });

  it('fails the row at once when the Compose file is refused, with the reason', async () => {
    await record();
    sources.fileAnswer = { status: 'missing' };

    await expect(handler.execute()).resolves.toEqual({ built: 0, dropped: 0, failed: 1 });

    expect((await rebuilds.find(PROJECT))?.failure).toContain('The Compose file was refused');
    expect(builds()).toEqual([]);
  });

  it('fails the row at once when the Compose file cannot be read', async () => {
    await record();
    sources.fileAnswer = { status: 'failed' };

    await expect(handler.execute()).resolves.toEqual({ built: 0, dropped: 0, failed: 1 });

    expect((await rebuilds.find(PROJECT))?.failure).toBe(
      'The Compose file could not be read from the Repository.',
    );
  });

  it('waits while no controller is connected, and builds when one is', async () => {
    await record();
    const kit = arrange();
    kit.presence.seen = new Date(NOW.getTime() - 61_000);

    await expect(handler.execute()).resolves.toEqual({ built: 0, dropped: 0, failed: 0 });
    expect(await rebuilds.find(PROJECT)).not.toBeNull();

    kit.presence.seen = NOW;
    await expect(handler.execute()).resolves.toMatchObject({ built: 1 });
  });

  it('keeps the latest merge: a second recording replaces the first and one build follows', async () => {
    await record();
    await rebuilds.save(
      PreviewMergeRebuild.record({
        projectId: PROJECT,
        runId: OTHER,
        mergedCommit: MERGED,
        mergedAt: minutes(0.2),
        fetchStartedAt: minutes(0.3),
        now: minutes(0.2),
      }),
    );

    await expect(handler.execute()).resolves.toMatchObject({ built: 1 });

    expect(builds()).toHaveLength(1);
    expect(builds()[0]!.build?.startedByRunId).toBe(OTHER);
    expect(await rebuilds.list()).toEqual([]);
  });
});
