import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewSettings } from '../../../../domain/entities/preview-settings.js';
import { ProjectNotFoundError } from '../../../../domain/errors/preview-settings-errors.js';
import { InMemoryPreviewSettingsRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-settings-repository.js';
import { FakePreviewSources } from '../../../ports/__tests__/fake-preview-sources.js';
import { RemovePreviewSettingsHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

describe('RemovePreviewSettingsHandler', () => {
  let sources: FakePreviewSources;
  let settings: InMemoryPreviewSettingsRepository;
  let handler: RemovePreviewSettingsHandler;

  beforeEach(() => {
    sources = new FakePreviewSources();
    settings = new InMemoryPreviewSettingsRepository();
    handler = new RemovePreviewSettingsHandler(sources, settings);
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
});
