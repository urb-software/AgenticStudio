import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { InMemoryPreviewSettingsRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-settings-repository.js';
import { PreviewOperation } from '../../../../domain/entities/preview-operation.js';
import {
  PreviewBuildRunningError,
  PreviewBusyError,
  PreviewControllerUnavailableError,
  PreviewLimitReachedError,
  PreviewRefusedError,
  PreviewRepositoryNotReadyError,
  PreviewSourceUnavailableError,
  ProjectNotFoundError,
} from '../../../../domain/errors/preview-settings-errors.js';
import { PreviewSettingsMissingError } from '../../../../domain/errors/preview-operation-errors.js';
import {
  COMMIT,
  COMPOSE_TEXT,
  FakePreviewSources,
} from '../../../ports/__tests__/fake-preview-sources.js';
import {
  BUILD_LIMITS,
  KIT_NOW as NOW,
  previewBuildRequests,
  savePreviewSettings,
} from '../../../__tests__/preview-test-kit.js';
import { RequestPreviewBuildHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const THIRD = '1c3a7e63-4e1c-4e7f-9b55-7c4d2e9a3b21';
const CONTROLLER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';

describe('RequestPreviewBuildHandler', () => {
  let sources: FakePreviewSources;
  let settings: InMemoryPreviewSettingsRepository;
  let operations: InMemoryPreviewOperationRepository;
  let kit: ReturnType<typeof previewBuildRequests>;
  let handler: RequestPreviewBuildHandler;

  function arrange(maxRunning = 3) {
    kit = previewBuildRequests(operations, sources, settings, { maxRunning });
    handler = new RequestPreviewBuildHandler(kit.requests);
  }

  beforeEach(() => {
    sources = new FakePreviewSources();
    settings = new InMemoryPreviewSettingsRepository();
    operations = new InMemoryPreviewOperationRepository();
    arrange();
  });

  const saveSettings = (projectId = PROJECT) => savePreviewSettings(settings, projectId);

  /** Gives the Project a running Preview, or a build that is still requested. */
  async function occupy(projectId: string, status: 'requested' | 'succeeded') {
    const build = kit.requests.operationOf(await kit.requests.prepareFromSettings(projectId));
    await operations.add(build);
    if (status === 'succeeded') {
      await operations.change(build.id, (op) => {
        op.claim(CONTROLLER, NOW);
        op.succeed(CONTROLLER, null, NOW);
      });
    }
    return build;
  }

  it('requests a build with the settings, the commit and the limits as they are now', async () => {
    await saveSettings();

    const { operationId } = await handler.execute({ projectId: PROJECT });

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
      limits: BUILD_LIMITS,
      startedByRunId: null,
    });
  });

  it('says the operator started the build', async () => {
    await saveSettings();

    const { build } = await handler.execute({ projectId: PROJECT });

    expect(build.startedBy).toEqual({ kind: 'operator' });
  });

  it('refuses an unknown Project', async () => {
    sources.statusAnswer = { status: 'project_not_found' };

    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    expect(operations.operations.size).toBe(0);
  });

  it.each(['no_repository', 'repository_not_ready', 'unsupported_platform'] as const)(
    'refuses a build while the Repository is %s',
    async (status) => {
      await saveSettings();
      sources.statusAnswer = { status };

      await expect(handler.execute({ projectId: PROJECT })).rejects.toMatchObject({
        constructor: PreviewRepositoryNotReadyError,
        reason: status,
      });
      expect(operations.operations.size).toBe(0);
    },
  );

  it('refuses a build when the Project has no Preview settings', async () => {
    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      PreviewSettingsMissingError,
    );
    expect(operations.operations.size).toBe(0);
  });

  it('answers the queued build', async () => {
    await saveSettings();

    const { operationId, build } = await handler.execute({ projectId: PROJECT });

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
    sources.statusAnswer = { status: 'ready', commit: 'd'.repeat(40), fetchedAt: null };
    sources.fileAnswer = { status: 'found', text: COMPOSE_TEXT, commit: 'e'.repeat(40) };

    const { operationId } = await handler.execute({ projectId: PROJECT });

    expect((await operations.find(operationId))?.build?.commit).toBe('e'.repeat(40));
    expect(sources.readIntegrationFile).toHaveBeenCalledWith(PROJECT, 'deploy/compose.yaml');
  });

  it('checks the settings before the Repository, the Repository before the controller', async () => {
    sources.statusAnswer = { status: 'repository_not_ready' };
    kit.presence.seen = null;
    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      PreviewSettingsMissingError,
    );

    await saveSettings();
    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      PreviewRepositoryNotReadyError,
    );

    sources.statusAnswer = { status: 'ready', commit: COMMIT, fetchedAt: null };
    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      PreviewControllerUnavailableError,
    );
    expect(sources.readIntegrationFile).not.toHaveBeenCalled();
  });

  it('refuses a build while no controller called within a lease', async () => {
    await saveSettings();
    kit.presence.seen = new Date(NOW.getTime() - 61_000);

    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      PreviewControllerUnavailableError,
    );
    expect(operations.operations.size).toBe(0);
  });

  it('refuses a second build while one is requested or claimed, and reads nothing', async () => {
    await saveSettings();
    await handler.execute({ projectId: PROJECT });

    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      PreviewBuildRunningError,
    );
    expect(sources.readIntegrationFile).toHaveBeenCalledTimes(1);
    expect(operations.operations.size).toBe(1);
  });

  it('refuses a build with busy while a stop or a reset is active', async () => {
    await saveSettings();
    await operations.add(
      PreviewOperation.requestOther({ id: CONTROLLER, projectId: PROJECT, kind: 'stop', now: NOW }),
    );

    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(PreviewBusyError);
    expect(sources.readIntegrationFile).not.toHaveBeenCalled();
  });

  it('accepts a build once the last one is final', async () => {
    await saveSettings();
    const first = await handler.execute({ projectId: PROJECT });
    await operations.change(first.operationId, (op) => {
      op.claim(CONTROLLER, NOW);
      op.succeed(CONTROLLER, null, NOW);
    });

    await expect(handler.execute({ projectId: PROJECT })).resolves.toBeDefined();
    expect(operations.operations.size).toBe(2);
  });

  it('refuses a Compose file the validation refuses at the current commit, and stores nothing', async () => {
    await saveSettings();
    sources.fileAnswer = {
      status: 'found',
      text: ['services:', '  web:', '    image: nginx:1.27', '    privileged: true', ''].join('\n'),
      commit: COMMIT,
    };

    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      PreviewRefusedError,
    );
    expect(operations.operations.size).toBe(0);
  });

  it('reports a file that could not be read, and a file that is gone', async () => {
    await saveSettings();
    sources.fileAnswer = { status: 'failed' };
    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      PreviewSourceUnavailableError,
    );

    sources.fileAnswer = { status: 'missing' };
    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      PreviewRefusedError,
    );
  });

  describe('the running limit', () => {
    beforeEach(async () => {
      arrange(2);
      await saveSettings(PROJECT);
      await saveSettings(OTHER);
      await saveSettings(THIRD);
    });

    it('accepts the last free place and refuses the next, naming who holds the places', async () => {
      sources.names.set(OTHER, 'Blog');
      await occupy(OTHER, 'succeeded');
      await expect(handler.execute({ projectId: PROJECT })).resolves.toBeDefined();

      const refused = await handler.execute({ projectId: THIRD }).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(PreviewLimitReachedError);
      const limit = refused as PreviewLimitReachedError;
      expect(limit.limit).toBe(2);
      expect(limit.running).toEqual(
        [
          { projectId: PROJECT, state: 'building' },
          { projectId: OTHER, state: 'running' },
        ].sort((a, b) => (a.projectId < b.projectId ? -1 : 1)),
      );
      expect(limit.names.get(OTHER)).toBe('Blog');
    });

    it('accepts a rebuild of a running Preview even when every place is taken', async () => {
      await occupy(PROJECT, 'succeeded');
      await occupy(OTHER, 'succeeded');

      await expect(handler.execute({ projectId: PROJECT })).resolves.toBeDefined();
    });

    it('frees a place when the Preview stops', async () => {
      await occupy(PROJECT, 'succeeded');
      await occupy(OTHER, 'succeeded');
      const stop = PreviewOperation.requestOther({
        id: '5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d',
        projectId: OTHER,
        kind: 'stop',
        now: new Date(NOW.getTime() + 1000),
      });
      await operations.add(stop);
      await operations.change(stop.id, (op) => {
        op.claim(CONTROLLER, NOW);
        op.succeed(CONTROLLER, null, new Date(NOW.getTime() + 2000));
      });

      await expect(handler.execute({ projectId: THIRD })).resolves.toBeDefined();
    });
  });
});
