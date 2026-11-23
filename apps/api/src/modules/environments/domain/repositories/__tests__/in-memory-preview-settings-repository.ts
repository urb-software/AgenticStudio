import { PreviewSettings } from '../../entities/preview-settings.js';
import { type RestoreData } from '../../../../../__tests__/restore-data.js';
import type { PreviewSettingsRepository } from '../preview-settings-repository.js';

export class InMemoryPreviewSettingsRepository implements PreviewSettingsRepository {
  readonly settings = new Map<string, RestoreData<typeof PreviewSettings>>();
  now = new Date('2026-11-23T10:00:00.000Z');

  find(projectId: string): Promise<PreviewSettings | null> {
    const stored = this.settings.get(projectId);
    return Promise.resolve(stored ? PreviewSettings.restore({ ...stored }) : null);
  }

  save(settings: PreviewSettings): Promise<PreviewSettings> {
    const { projectId, composeFile, service, port } = settings;
    const stored = { projectId, composeFile, service, port, updatedAt: this.now };
    this.settings.set(projectId, stored);
    return Promise.resolve(PreviewSettings.restore(stored));
  }

  delete(projectId: string): Promise<void> {
    this.settings.delete(projectId);
    return Promise.resolve();
  }
}
