import { beforeEach, describe, expect, it } from 'vitest';
import { INTEGRATION_FILE_MAX_BYTES } from '../../../../../projects/contracts/index.js';
import {
  PreviewRefusedError,
  PreviewRepositoryNotReadyError,
  PreviewSourceUnavailableError,
  ProjectNotFoundError,
  DefinitionsProjectError,
} from '../../../../domain/errors/preview-settings-errors.js';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { InMemoryPreviewSettingsRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-settings-repository.js';
import { InvalidPreviewPortError } from '../../../../domain/value-objects/preview-port.js';
import { InvalidPreviewServiceError } from '../../../../domain/value-objects/preview-service.js';
import {
  COMMIT,
  COMPOSE_TEXT,
  FakePreviewSources,
} from '../../../ports/__tests__/fake-preview-sources.js';
import { previewKit } from '../../../__tests__/preview-test-kit.js';
import { SavePreviewSettingsHandler } from '../handler.js';
import { FakeProjectKinds } from '../../../ports/__tests__/fake-project-kinds.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const INPUT = { projectId: PROJECT, composeFile: 'compose.yaml', service: 'web', port: 80 };

describe('SavePreviewSettingsHandler', () => {
  let sources: FakePreviewSources;
  const kinds = new FakeProjectKinds();
  let settings: InMemoryPreviewSettingsRepository;
  let domain: { domain: string | null };
  let handler: SavePreviewSettingsHandler;

  beforeEach(() => {
    sources = new FakePreviewSources();
    kinds.kind = 'code';
    settings = new InMemoryPreviewSettingsRepository();
    domain = { domain: 'preview.example.test' };
    const kit = previewKit(new InMemoryPreviewOperationRepository(), sources);
    handler = new SavePreviewSettingsHandler(
      kinds,
      sources,
      settings,
      domain,
      kit.judge,
      kit.states,
    );
  });

  async function refusalsOf(input = INPUT) {
    const error = await handler.execute(input).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(PreviewRefusedError);
    return (error as PreviewRefusedError).refusals;
  }

  it('saves what the validation accepts and answers the Preview, with the ports it removed', async () => {
    const result = await handler.execute(INPUT);

    expect(result).toEqual({
      settings: {
        composeFile: 'compose.yaml',
        service: 'web',
        port: 80,
        updatedAt: settings.now,
      },
      hostname: 'preview-3f2b8c1e4d5a.preview.example.test',
      repository: { ready: true, commit: COMMIT },
      state: 'stopped',
      running: null,
      latestBuild: null,
      latestChange: null,
      controller: { connected: false },
      behind: false,
      mergeRebuild: null,
      removedPorts: [{ service: 'web', place: 'services.web.ports[0]' }],
    });
    expect(settings.settings.get(PROJECT)).toMatchObject({ composeFile: 'compose.yaml', port: 80 });
    expect(sources.readIntegrationFile).toHaveBeenCalledWith(PROJECT, 'compose.yaml');
  });

  it('replaces the settings it saved before', async () => {
    await handler.execute(INPUT);
    settings.now = new Date('2026-11-24T10:00:00.000Z');

    const result = await handler.execute({ ...INPUT, port: 8080 });

    expect(result.settings).toMatchObject({ port: 8080, updatedAt: settings.now });
    expect(settings.settings.size).toBe(1);
  });

  it('says there is no hostname while no preview domain is configured', async () => {
    domain.domain = null;

    await expect(handler.execute(INPUT)).resolves.toMatchObject({
      hostname: null,
      hostnameUnavailable: 'not_configured',
    });
  });

  it('refuses what the validation refuses, with the code and the place, and saves nothing', async () => {
    sources.fileAnswer = {
      status: 'found',
      text: 'services:\n  web:\n    image: nginx:1.27\n    privileged: true\n',
      commit: 'c'.repeat(40),
    };

    expect(await refusalsOf()).toEqual([
      expect.objectContaining({ code: 'privileged', place: 'services.web.privileged' }),
    ]);
    expect(settings.settings.size).toBe(0);
  });

  it('refuses a service the file does not have, as the validation does', async () => {
    expect(await refusalsOf({ ...INPUT, service: 'api' })).toEqual([
      expect.objectContaining({ code: 'entry_service_missing' }),
    ]);
  });

  it('refuses an unsafe path as invalid_path at composeFile, before it reads anything', async () => {
    for (const composeFile of ['../x', '/etc/x', 'a\\b', './a', 'a//b', '']) {
      expect(await refusalsOf({ ...INPUT, composeFile })).toEqual([
        { code: 'invalid_path', place: 'composeFile', message: expect.any(String) },
      ]);
    }
    expect(sources.readIntegrationFile).not.toHaveBeenCalled();
  });

  it('refuses an unsafe path as invalid_path even while the Repository is not ready', async () => {
    sources.statusAnswer = { status: 'repository_not_ready' };

    expect(await refusalsOf({ ...INPUT, composeFile: '../x' })).toEqual([
      { code: 'invalid_path', place: 'composeFile', message: expect.any(String) },
    ]);
    await expect(handler.execute(INPUT)).rejects.toBeInstanceOf(PreviewRepositoryNotReadyError);
  });

  it('refuses a file that is not in the tree, or is no regular file, as compose_file_missing', async () => {
    sources.fileAnswer = { status: 'missing' };

    expect(await refusalsOf()).toEqual([
      { code: 'compose_file_missing', place: 'composeFile', message: expect.any(String) },
    ]);
  });

  it('refuses a file over the limit as compose_file_too_large, without judging it', async () => {
    sources.fileAnswer = { status: 'too_large' };

    expect(await refusalsOf()).toEqual([
      { code: 'compose_file_too_large', place: 'composeFile', message: expect.any(String) },
    ]);
  });

  it('reads at most as much as the validation judges', async () => {
    const { MAX_TEXT_BYTES } = await import('@agentic-studio/compose-validation');

    expect(INTEGRATION_FILE_MAX_BYTES).toBe(MAX_TEXT_BYTES);
  });

  it('names an unknown project before it looks at the request', async () => {
    sources.statusAnswer = { status: 'project_not_found' };

    await expect(handler.execute({ ...INPUT, composeFile: '../x' })).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    sources.statusAnswer = { status: 'ready', commit: COMMIT, fetchedAt: null };
    sources.fileAnswer = { status: 'project_not_found' };
    await expect(handler.execute(INPUT)).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it.each(['no_repository', 'repository_not_ready', 'unsupported_platform'] as const)(
    'refuses with %s while the Repository cannot be read',
    async (status) => {
      sources.statusAnswer = { status };

      await expect(handler.execute(INPUT)).rejects.toMatchObject({
        constructor: PreviewRepositoryNotReadyError,
        reason: status,
      });
      expect(sources.readIntegrationFile).not.toHaveBeenCalled();
    },
  );

  it.each(['repository_not_ready', 'unsupported_platform'] as const)(
    'refuses with %s when the read finds it so',
    async (status) => {
      sources.fileAnswer = { status };

      await expect(handler.execute(INPUT)).rejects.toMatchObject({
        constructor: PreviewRepositoryNotReadyError,
        reason: status,
      });
    },
  );

  it('fails with an error of its own when the file could not be read', async () => {
    sources.fileAnswer = { status: 'failed' };

    await expect(handler.execute(INPUT)).rejects.toBeInstanceOf(PreviewSourceUnavailableError);
  });

  it('rejects a service or a port the domain refuses', async () => {
    await expect(handler.execute({ ...INPUT, service: '-web' })).rejects.toBeInstanceOf(
      InvalidPreviewServiceError,
    );
    await expect(handler.execute({ ...INPUT, port: 0 })).rejects.toBeInstanceOf(
      InvalidPreviewPortError,
    );
  });

  it('keeps no removed port in the answer when the file publishes none', async () => {
    sources.fileAnswer = {
      status: 'found',
      text: COMPOSE_TEXT.replace(/ {4}ports:\n.*\n/, ''),
      commit: 'c'.repeat(40),
    };

    await expect(handler.execute(INPUT)).resolves.toMatchObject({ removedPorts: [] });
  });

  it('refuses the definitions Repository before it reads anything else', async () => {
    kinds.kind = 'definitions';

    await expect(handler.execute(INPUT)).rejects.toBeInstanceOf(DefinitionsProjectError);
    expect(sources.status).not.toHaveBeenCalled();
    expect(await settings.find(PROJECT)).toBeNull();
  });
});
