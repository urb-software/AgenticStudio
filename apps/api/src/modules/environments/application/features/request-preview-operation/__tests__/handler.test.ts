import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { InMemoryPreviewSettingsRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-settings-repository.js';
import { PreviewSettings } from '../../../../domain/entities/preview-settings.js';
import {
  PreviewRepositoryNotReadyError,
  ProjectNotFoundError,
} from '../../../../domain/errors/preview-settings-errors.js';
import { PreviewSettingsMissingError } from '../../../../domain/errors/preview-operation-errors.js';
import { PreviewComposeFile } from '../../../../domain/value-objects/preview-compose-file.js';
import { PreviewPort } from '../../../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../../../domain/value-objects/preview-service.js';
import { COMMIT, FakePreviewSources } from '../../../ports/__tests__/fake-preview-sources.js';
import { RequestPreviewOperationHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const NOW = new Date('2026-11-24T10:00:00.000Z');
const LIMITS = { memoryMiB: 2048, cpuPercent: 200, tasksMax: 1024, buildMinutes: 30 };

describe('RequestPreviewOperationHandler', () => {
  let sources: FakePreviewSources;
  let settings: InMemoryPreviewSettingsRepository;
  let operations: InMemoryPreviewOperationRepository;
  let handler: RequestPreviewOperationHandler;

  beforeEach(() => {
    sources = new FakePreviewSources();
    settings = new InMemoryPreviewSettingsRepository();
    operations = new InMemoryPreviewOperationRepository();
    handler = new RequestPreviewOperationHandler(sources, settings, operations, LIMITS, {
      now: () => NOW,
    });
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
});
