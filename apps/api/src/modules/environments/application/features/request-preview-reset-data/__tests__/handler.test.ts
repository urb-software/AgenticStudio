import { beforeEach, describe, expect, it } from 'vitest';
import {
  PreviewBuildRunningError,
  PreviewBusyError,
  PreviewControllerUnavailableError,
  ProjectNotFoundError,
} from '../../../../domain/errors/preview-settings-errors.js';
import { PreviewOperation } from '../../../../domain/entities/preview-operation.js';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { InMemoryPreviewSettingsRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-settings-repository.js';
import { PreviewOperationHandOutRule } from '../../../../domain/value-objects/preview-operation-hand-out-rule.js';
import { FakePreviewSources } from '../../../ports/__tests__/fake-preview-sources.js';
import {
  BUILD_LIMITS,
  KIT_NOW as NOW,
  previewBuildRequests,
  seedBuild,
} from '../../../__tests__/preview-test-kit.js';
import { RequestPreviewResetDataHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const BUILD = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';
const COMMIT = 'e'.repeat(40);

describe('RequestPreviewResetDataHandler', () => {
  let sources: FakePreviewSources;
  let operations: InMemoryPreviewOperationRepository;
  let settings: InMemoryPreviewSettingsRepository;
  let kit: ReturnType<typeof previewBuildRequests>;
  let handler: RequestPreviewResetDataHandler;

  beforeEach(() => {
    sources = new FakePreviewSources();
    operations = new InMemoryPreviewOperationRepository();
    settings = new InMemoryPreviewSettingsRepository();
    kit = previewBuildRequests(operations, sources, settings);
    handler = new RequestPreviewResetDataHandler(operations, kit.clock, kit.requests);
  });

  const stored = () => [...operations.operations.values()];

  it('removes the data of a running Preview and rebuilds it from its own build, in two operations', async () => {
    await seedBuild(operations, PROJECT, BUILD, 'succeeded', NOW, COMMIT);
    operations.leaseSeconds = 60;

    const { operationId, buildId } = await handler.execute({ projectId: PROJECT });

    const removal = await operations.find(operationId);
    const rebuild = await operations.find(buildId!);
    expect(removal).toMatchObject({ kind: 'remove_data', status: 'requested' });
    expect(rebuild).toMatchObject({ kind: 'build', status: 'requested' });
    expect(rebuild?.build).toEqual({
      commit: COMMIT,
      composeFile: 'deploy/compose.yaml',
      service: 'web',
      port: 8080,
      limits: BUILD_LIMITS,
    });
    expect(rebuild!.requestedAt.getTime()).toBeGreaterThan(removal!.requestedAt.getTime());
  });

  it('rebuilds with the limits of today, not those of the running build', async () => {
    await seedBuild(operations, PROJECT, BUILD, 'succeeded', NOW, COMMIT);
    const changed = previewBuildRequests(operations, sources, settings, {
      limits: { ...BUILD_LIMITS, memoryMiB: 4096 },
    });

    const { buildId } = await new RequestPreviewResetDataHandler(
      operations,
      changed.clock,
      changed.requests,
    ).execute({ projectId: PROJECT });

    expect((await operations.find(buildId!))?.build?.limits.memoryMiB).toBe(4096);
  });

  it('hands the data removal out before the rebuild', async () => {
    await seedBuild(operations, PROJECT, BUILD, 'succeeded', NOW, COMMIT);
    await handler.execute({ projectId: PROJECT });

    const rule = PreviewOperationHandOutRule.at(NOW, 60);
    expect(rule.next(stored())?.kind).toBe('remove_data');
  });

  it('takes the data of a Preview that does not run, without a build and without settings', async () => {
    const { operationId, buildId } = await handler.execute({ projectId: PROJECT });

    expect(buildId).toBeNull();
    expect(stored()).toHaveLength(1);
    expect(await operations.find(operationId)).toMatchObject({ kind: 'remove_data' });
  });

  it('takes the data of a stopped Preview without rebuilding it', async () => {
    await seedBuild(operations, PROJECT, BUILD, 'succeeded');
    await operations.add(
      PreviewOperation.requestOther({
        id: '1c3a7e63-4e1c-4e7f-9b55-7c4d2e9a3b21',
        projectId: PROJECT,
        kind: 'stop',
        now: new Date(NOW.getTime() + 60_000),
      }),
    );
    await operations.change('1c3a7e63-4e1c-4e7f-9b55-7c4d2e9a3b21', (op) => {
      op.claim('7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a', NOW);
      op.succeed('7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a', null, new Date(NOW.getTime() + 90_000));
    });

    const { buildId } = await handler.execute({ projectId: PROJECT });

    expect(buildId).toBeNull();
  });

  it('refuses an unknown Project and a missing controller, and stores nothing', async () => {
    sources.statusAnswer = { status: 'project_not_found' };
    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );

    sources.statusAnswer = { status: 'ready', commit: COMMIT };
    kit.presence.seen = null;
    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      PreviewControllerUnavailableError,
    );
    expect(stored()).toHaveLength(0);
  });

  it('refuses with build_running while a build is active, and with busy during a stop or reset', async () => {
    await seedBuild(operations, PROJECT, BUILD, 'requested');
    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      PreviewBuildRunningError,
    );

    const other = new InMemoryPreviewOperationRepository();
    await seedBuild(other, PROJECT, BUILD, 'succeeded');
    const again = previewBuildRequests(other, sources, settings);
    const second = new RequestPreviewResetDataHandler(other, again.clock, again.requests);
    await second.execute({ projectId: PROJECT });
    await expect(second.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(PreviewBusyError);
    expect([...other.operations.values()]).toHaveLength(3);
  });

  it('leaves the limit alone: a running Preview keeps its place at a full limit', async () => {
    const full = previewBuildRequests(operations, sources, settings, { maxRunning: 1 });
    await seedBuild(operations, PROJECT, BUILD, 'succeeded');

    await expect(
      new RequestPreviewResetDataHandler(operations, full.clock, full.requests).execute({
        projectId: PROJECT,
      }),
    ).resolves.toMatchObject({ buildId: expect.any(String) });
  });
});
