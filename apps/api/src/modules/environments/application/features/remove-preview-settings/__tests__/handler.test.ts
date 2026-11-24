import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewSettings } from '../../../../domain/entities/preview-settings.js';
import { PreviewCommit } from '../../../../domain/value-objects/preview-commit.js';
import { PreviewComposeFile } from '../../../../domain/value-objects/preview-compose-file.js';
import { PreviewLimits } from '../../../../domain/value-objects/preview-limits.js';
import { PreviewPort } from '../../../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../../../domain/value-objects/preview-service.js';
import { PreviewOperation } from '../../../../domain/entities/preview-operation.js';
import {
  PreviewBuildRunningError,
  PreviewRunningError,
  ProjectNotFoundError,
} from '../../../../domain/errors/preview-settings-errors.js';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { InMemoryPreviewSettingsRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-settings-repository.js';
import { FakePreviewSources } from '../../../ports/__tests__/fake-preview-sources.js';
import { RemovePreviewSettingsHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

describe('RemovePreviewSettingsHandler', () => {
  let sources: FakePreviewSources;
  let settings: InMemoryPreviewSettingsRepository;
  let operations: InMemoryPreviewOperationRepository;
  let handler: RemovePreviewSettingsHandler;

  beforeEach(() => {
    sources = new FakePreviewSources();
    settings = new InMemoryPreviewSettingsRepository();
    operations = new InMemoryPreviewOperationRepository();
    handler = new RemovePreviewSettingsHandler(sources, settings, operations);
  });

  async function saved() {
    await settings.save(
      PreviewSettings.restore({
        projectId: PROJECT,
        composeFile: 'compose.yaml',
        service: 'web',
        port: 3000,
        updatedAt: new Date(),
      }),
    );
  }

  it('removes the settings', async () => {
    await saved();

    await handler.execute({ projectId: PROJECT });

    expect(settings.settings.size).toBe(0);
  });

  it('changes nothing when there are none', async () => {
    await expect(handler.execute({ projectId: PROJECT })).resolves.toBeUndefined();
  });

  it('names an unknown project, and leaves the settings alone', async () => {
    await saved();
    sources.statusAnswer = { status: 'project_not_found' };

    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    expect(settings.settings.size).toBe(1);
  });

  it('removes them even when the Repository is not ready', async () => {
    await saved();
    sources.statusAnswer = { status: 'repository_not_ready' };

    await handler.execute({ projectId: PROJECT });

    expect(settings.settings.size).toBe(0);
  });

  const CONTROLLER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
  const NOW = new Date('2026-11-24T10:00:00.000Z');

  async function build(id: string) {
    await operations.add(
      PreviewOperation.requestBuild({
        id,
        projectId: PROJECT,
        commit: PreviewCommit.of('a'.repeat(40)),
        composeFile: PreviewComposeFile.of('compose.yaml'),
        service: PreviewService.of('web'),
        port: PreviewPort.of(3000),
        limits: PreviewLimits.of({
          memoryMiB: 1024,
          cpuPercent: 100,
          tasksMax: 512,
          buildMinutes: 20,
        }),
        now: NOW,
      }),
    );
  }

  it('refuses while a build is requested or claimed, and keeps the settings', async () => {
    await saved();
    await build('0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10');

    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      PreviewBuildRunningError,
    );
    await operations.claimNext(CONTROLLER, NOW);
    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      PreviewBuildRunningError,
    );
    expect(settings.settings.size).toBe(1);
  });

  it('refuses while the Preview runs: a succeeded build, until a stop succeeded', async () => {
    await saved();
    await build('0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10');
    await operations.change('0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10', (op) => {
      op.claim(CONTROLLER, NOW);
      op.succeed(CONTROLLER, null, new Date(NOW.getTime() + 1000));
    });

    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      PreviewRunningError,
    );

    const stop = PreviewOperation.requestOther({
      id: '1c3a7e63-4e1c-4e7f-9b55-7c4d2e9a3b21',
      projectId: PROJECT,
      kind: 'stop',
      now: new Date(NOW.getTime() + 2000),
    });
    await operations.add(stop);
    await operations.change(stop.id, (op) => {
      op.claim(CONTROLLER, new Date(NOW.getTime() + 3000));
      op.succeed(CONTROLLER, null, new Date(NOW.getTime() + 4000));
    });

    await handler.execute({ projectId: PROJECT });
    expect(settings.settings.size).toBe(0);
  });
});
