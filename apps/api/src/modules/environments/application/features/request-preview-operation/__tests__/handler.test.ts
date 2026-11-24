import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { InMemoryPreviewSettingsRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-settings-repository.js';
import { PreviewSettings } from '../../../../domain/entities/preview-settings.js';
import {
  PreviewBuildRunningError,
  PreviewControllerUnavailableError,
  PreviewRefusedError,
  PreviewRepositoryNotReadyError,
  PreviewSourceUnavailableError,
  ProjectNotFoundError,
} from '../../../../domain/errors/preview-settings-errors.js';
import { PreviewSettingsMissingError } from '../../../../domain/errors/preview-operation-errors.js';
import { PreviewComposeFile } from '../../../../domain/value-objects/preview-compose-file.js';
import { PreviewPort } from '../../../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../../../domain/value-objects/preview-service.js';
import {
  COMMIT,
  COMPOSE_TEXT,
  FakePreviewSources,
} from '../../../ports/__tests__/fake-preview-sources.js';
import { OPERATION_SETTINGS, previewKit } from '../../../__tests__/preview-test-kit.js';
import { RequestPreviewOperationHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const NOW = new Date('2026-11-24T10:00:00.000Z');
const LIMITS = { memoryMiB: 2048, cpuPercent: 200, tasksMax: 1024, buildMinutes: 30 };

describe('RequestPreviewOperationHandler', () => {
  let sources: FakePreviewSources;
  let settings: InMemoryPreviewSettingsRepository;
  let operations: InMemoryPreviewOperationRepository;
  let kit: ReturnType<typeof previewKit>;
  let handler: RequestPreviewOperationHandler;

  beforeEach(() => {
    sources = new FakePreviewSources();
    settings = new InMemoryPreviewSettingsRepository();
    operations = new InMemoryPreviewOperationRepository();
    kit = previewKit(operations, sources, NOW);
    kit.presence.seen = NOW;
    handler = new RequestPreviewOperationHandler(
      sources,
      settings,
      operations,
      LIMITS,
      { now: () => NOW },
      kit.judge,
      kit.presence,
      OPERATION_SETTINGS,
    );
  });

  async function saveSettings() {
    await settings.save(
      PreviewSettings.create({
        projectId: PROJECT,
        composeFile: PreviewComposeFile.of('deploy/compose.yaml'),
        service: PreviewService.of('web'),
        port: PreviewPort.of(8080),
        now: NOW,
      }),
    );
  }

  it('requests a build with the settings, the commit and the limits as they are now', async () => {
    await saveSettings();

    const { operationId } = await handler.execute({ projectId: PROJECT, kind: 'build' });

    const stored = await operations.find(operationId);
    expect(stored).toMatchObject({
      projectId: PROJECT,
      kind: 'build',
      status: 'requested',
      requestedAt: NOW,
    });
    expect(stored?.build).toEqual({
      commit: COMMIT,
      composeFile: 'deploy/compose.yaml',
      service: 'web',
      port: 8080,
      limits: LIMITS,
    });
  });

  it.each(['stop', 'remove_data', 'state'] as const)(
    'requests %s without settings or a ready Repository',
    async (kind) => {
      sources.statusAnswer = { status: 'repository_not_ready' };

      const { operationId } = await handler.execute({ projectId: PROJECT, kind });

      expect(await operations.find(operationId)).toMatchObject({ kind, status: 'requested' });
    },
  );

  it('refuses an unknown Project for every kind', async () => {
    sources.statusAnswer = { status: 'project_not_found' };

    for (const kind of ['build', 'stop', 'remove_data', 'state'] as const) {
      await expect(handler.execute({ projectId: PROJECT, kind })).rejects.toBeInstanceOf(
        ProjectNotFoundError,
      );
    }
    expect(operations.operations.size).toBe(0);
  });

  it.each(['no_repository', 'repository_not_ready', 'unsupported_platform'] as const)(
    'refuses a build while the Repository is %s',
    async (status) => {
      await saveSettings();
      sources.statusAnswer = { status };

      await expect(handler.execute({ projectId: PROJECT, kind: 'build' })).rejects.toMatchObject({
        constructor: PreviewRepositoryNotReadyError,
        reason: status,
      });
      expect(operations.operations.size).toBe(0);
    },
  );

  it('refuses a build when the Project has no Preview settings', async () => {
    await expect(handler.execute({ projectId: PROJECT, kind: 'build' })).rejects.toBeInstanceOf(
      PreviewSettingsMissingError,
    );
    expect(operations.operations.size).toBe(0);
  });

  it('answers the queued build', async () => {
    await saveSettings();

    const { operationId, build } = await handler.execute({ projectId: PROJECT, kind: 'build' });

    expect(build).toMatchObject({
      id: operationId,
      commit: COMMIT,
      status: 'queued',
      requestedAt: NOW,
      timeLimitMinutes: 30,
      failure: null,
    });
  });

  it('builds the commit that was read for the judgement, not the one status reported', async () => {
    await saveSettings();
    sources.statusAnswer = { status: 'ready', commit: 'd'.repeat(40) };
    sources.fileAnswer = { status: 'found', text: COMPOSE_TEXT, commit: 'e'.repeat(40) };

    const { operationId } = await handler.execute({ projectId: PROJECT, kind: 'build' });

    expect((await operations.find(operationId))?.build?.commit).toBe('e'.repeat(40));
    expect(sources.readIntegrationFile).toHaveBeenCalledWith(PROJECT, 'deploy/compose.yaml');
  });

  it('checks the settings before the Repository, the Repository before the controller', async () => {
    sources.statusAnswer = { status: 'repository_not_ready' };
    kit.presence.seen = null;
    await expect(handler.execute({ projectId: PROJECT, kind: 'build' })).rejects.toBeInstanceOf(
      PreviewSettingsMissingError,
    );

    await saveSettings();
    await expect(handler.execute({ projectId: PROJECT, kind: 'build' })).rejects.toBeInstanceOf(
      PreviewRepositoryNotReadyError,
    );

    sources.statusAnswer = { status: 'ready', commit: COMMIT };
    await expect(handler.execute({ projectId: PROJECT, kind: 'build' })).rejects.toBeInstanceOf(
      PreviewControllerUnavailableError,
    );
    expect(sources.readIntegrationFile).not.toHaveBeenCalled();
  });

  it('refuses a build while no controller called within a lease', async () => {
    await saveSettings();
    kit.presence.seen = new Date(NOW.getTime() - 61_000);

    await expect(handler.execute({ projectId: PROJECT, kind: 'build' })).rejects.toBeInstanceOf(
      PreviewControllerUnavailableError,
    );
    expect(operations.operations.size).toBe(0);
  });

  it('refuses a second build while one is requested or claimed, and reads nothing', async () => {
    await saveSettings();
    await handler.execute({ projectId: PROJECT, kind: 'build' });

    await expect(handler.execute({ projectId: PROJECT, kind: 'build' })).rejects.toBeInstanceOf(
      PreviewBuildRunningError,
    );
    expect(sources.readIntegrationFile).toHaveBeenCalledTimes(1);
    expect(operations.operations.size).toBe(1);
  });

  it('accepts a build once the last one is final', async () => {
    await saveSettings();
    const first = await handler.execute({ projectId: PROJECT, kind: 'build' });
    await operations.change(first.operationId, (op) => {
      op.claim('7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a', NOW);
      op.succeed('7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a', null, NOW);
    });

    await expect(handler.execute({ projectId: PROJECT, kind: 'build' })).resolves.toBeDefined();
    expect(operations.operations.size).toBe(2);
  });

  it('refuses a Compose file the validation refuses at the current commit, and stores nothing', async () => {
    await saveSettings();
    sources.fileAnswer = {
      status: 'found',
      text: ['services:', '  web:', '    image: nginx:1.27', '    privileged: true', ''].join('\n'),
      commit: COMMIT,
    };

    await expect(handler.execute({ projectId: PROJECT, kind: 'build' })).rejects.toBeInstanceOf(
      PreviewRefusedError,
    );
    expect(operations.operations.size).toBe(0);
  });

  it('reports a file that could not be read, and a file that is gone', async () => {
    await saveSettings();
    sources.fileAnswer = { status: 'failed' };
    await expect(handler.execute({ projectId: PROJECT, kind: 'build' })).rejects.toBeInstanceOf(
      PreviewSourceUnavailableError,
    );

    sources.fileAnswer = { status: 'missing' };
    await expect(handler.execute({ projectId: PROJECT, kind: 'build' })).rejects.toBeInstanceOf(
      PreviewRefusedError,
    );
  });

  it('asks for a stop with no controller connected and builds nothing', async () => {
    kit.presence.seen = null;

    const { build } = await handler.execute({ projectId: PROJECT, kind: 'stop' });

    expect(build).toBeNull();
  });
});
