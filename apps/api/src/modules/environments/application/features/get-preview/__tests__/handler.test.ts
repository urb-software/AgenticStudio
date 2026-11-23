import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewSettings } from '../../../../domain/entities/preview-settings.js';
import { ProjectNotFoundError } from '../../../../domain/errors/preview-settings-errors.js';
import { InMemoryPreviewSettingsRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-settings-repository.js';
import { FakePreviewSources } from '../../../ports/__tests__/fake-preview-sources.js';
import { GetPreviewHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

describe('GetPreviewHandler', () => {
  let sources: FakePreviewSources;
  let settings: InMemoryPreviewSettingsRepository;
  let domain: { domain: string | null };
  let handler: GetPreviewHandler;

  beforeEach(() => {
    sources = new FakePreviewSources();
    settings = new InMemoryPreviewSettingsRepository();
    domain = { domain: 'preview.example.test' };
    handler = new GetPreviewHandler(sources, settings, domain);
  });

  it('answers no settings, the hostname and a ready Repository for a new Project', async () => {
    await expect(handler.execute({ projectId: PROJECT })).resolves.toEqual({
      settings: null,
      hostname: 'preview-3f2b8c1e4d5a.preview.example.test',
      repository: { ready: true },
    });
  });

  it('answers the settings that were saved', async () => {
    await settings.save(
      PreviewSettings.restore({
        projectId: PROJECT,
        composeFile: 'compose.yaml',
        service: 'web',
        port: 3000,
        updatedAt: new Date(),
      }),
    );

    await expect(handler.execute({ projectId: PROJECT })).resolves.toMatchObject({
      settings: { composeFile: 'compose.yaml', service: 'web', port: 3000 },
    });
  });

  it('says why there is no hostname while no preview domain is configured', async () => {
    domain.domain = null;

    await expect(handler.execute({ projectId: PROJECT })).resolves.toEqual({
      settings: null,
      hostname: null,
      hostnameUnavailable: 'not_configured',
      repository: { ready: true },
    });
  });

  it.each(['no_repository', 'repository_not_ready', 'unsupported_platform'] as const)(
    'says the Repository is not ready, with %s',
    async (status) => {
      sources.statusAnswer = { status };

      await expect(handler.execute({ projectId: PROJECT })).resolves.toMatchObject({
        repository: { ready: false, reason: status },
      });
    },
  );

  it('names an unknown project', async () => {
    sources.statusAnswer = { status: 'project_not_found' };

    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });
});
