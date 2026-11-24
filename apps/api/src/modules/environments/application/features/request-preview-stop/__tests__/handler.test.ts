import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewOperation } from '../../../../domain/entities/preview-operation.js';
import {
  PreviewBuildRunningError,
  PreviewBusyError,
  PreviewControllerUnavailableError,
  PreviewNotRunningError,
  ProjectNotFoundError,
} from '../../../../domain/errors/preview-settings-errors.js';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { InMemoryPreviewSettingsRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-settings-repository.js';
import { FakePreviewSources } from '../../../ports/__tests__/fake-preview-sources.js';
import {
  KIT_CONTROLLER,
  KIT_NOW as NOW,
  previewBuildRequests,
  seedBuild,
} from '../../../__tests__/preview-test-kit.js';
import { RequestPreviewStopHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const BUILD = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';
const CHANGE = '1c3a7e63-4e1c-4e7f-9b55-7c4d2e9a3b21';

describe('RequestPreviewStopHandler', () => {
  let sources: FakePreviewSources;
  let operations: InMemoryPreviewOperationRepository;
  let kit: ReturnType<typeof previewBuildRequests>;
  let handler: RequestPreviewStopHandler;

  beforeEach(() => {
    sources = new FakePreviewSources();
    operations = new InMemoryPreviewOperationRepository();
    kit = previewBuildRequests(operations, sources, new InMemoryPreviewSettingsRepository());
    handler = new RequestPreviewStopHandler(operations, kit.clock, kit.requests);
  });

  const stored = () => [...operations.operations.values()];

  it('requests a stop of a running Preview', async () => {
    await seedBuild(operations, PROJECT, BUILD, 'succeeded');

    const { operationId } = await handler.execute({ projectId: PROJECT });

    expect(await operations.find(operationId)).toMatchObject({
      projectId: PROJECT,
      kind: 'stop',
      status: 'requested',
      requestedAt: NOW,
    });
  });

  it('refuses an unknown Project, and needs no settings', async () => {
    sources.statusAnswer = { status: 'project_not_found' };
    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );

    sources.statusAnswer = { status: 'repository_not_ready' };
    await seedBuild(operations, PROJECT, BUILD, 'succeeded');
    await expect(handler.execute({ projectId: PROJECT })).resolves.toBeDefined();
  });

  it('refuses while no controller is connected, before it looks at the state', async () => {
    kit.presence.seen = null;

    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      PreviewControllerUnavailableError,
    );
    expect(stored()).toHaveLength(0);
  });

  it.each([
    ['never built', [], PreviewNotRunningError],
    ['failed', ['failed'], PreviewNotRunningError],
    ['building', ['requested'], PreviewBuildRunningError],
    ['building over a running one', ['succeeded', 'requested'], PreviewBuildRunningError],
  ] as const)(
    'refuses a Preview that is %s',
    async (_name, statuses: readonly ('requested' | 'succeeded' | 'failed')[], refusal) => {
      for (const [index, status] of statuses.entries()) {
        await seedBuild(
          operations,
          PROJECT,
          `0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a1${index}`,
          status,
          new Date(NOW.getTime() + index * 120_000),
        );
      }

      await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(refusal);
      expect(stored().filter((operation) => operation.kind === 'stop')).toHaveLength(0);
    },
  );

  it('refuses a second stop with busy, and a stop while a reset is active', async () => {
    await seedBuild(operations, PROJECT, BUILD, 'succeeded');
    await handler.execute({ projectId: PROJECT });
    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(PreviewBusyError);

    const other = new InMemoryPreviewOperationRepository();
    await seedBuild(other, PROJECT, BUILD, 'succeeded');
    await other.add(
      PreviewOperation.requestOther({
        id: CHANGE,
        projectId: PROJECT,
        kind: 'remove_data',
        now: new Date(NOW.getTime() + 120_000),
      }),
    );
    const again = previewBuildRequests(other, sources, new InMemoryPreviewSettingsRepository());
    await expect(
      new RequestPreviewStopHandler(other, again.clock, again.requests).execute({
        projectId: PROJECT,
      }),
    ).rejects.toBeInstanceOf(PreviewBusyError);
  });

  it('accepts a stop again once the last one is final, for a Preview that runs again', async () => {
    await seedBuild(operations, PROJECT, BUILD, 'succeeded');
    const { operationId } = await handler.execute({ projectId: PROJECT });
    await operations.change(operationId, (op) => {
      op.claim(KIT_CONTROLLER, NOW);
      op.succeed(KIT_CONTROLLER, null, new Date(NOW.getTime() + 120_000));
    });
    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      PreviewNotRunningError,
    );

    await seedBuild(
      operations,
      PROJECT,
      '2d4b8f74-5f2d-4f80-8c66-8d5e3f0b4c32',
      'succeeded',
      new Date(NOW.getTime() + 600_000),
    );
    await expect(handler.execute({ projectId: PROJECT })).resolves.toBeDefined();
  });
});
