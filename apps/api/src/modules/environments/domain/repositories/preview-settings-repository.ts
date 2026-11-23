import type { PreviewSettings } from '../entities/preview-settings.js';

export const PREVIEW_SETTINGS_REPOSITORY = Symbol('PREVIEW_SETTINGS_REPOSITORY');

export interface PreviewSettingsRepository {
  /** The Project's settings, or `null` when none are set. */
  find(projectId: string): Promise<PreviewSettings | null>;

  /**
   * Stores the settings, new or replacing the Project's, with `updatedAt` set by the store; returns
   * them as stored. The caller checks that the Project exists.
   */
  save(settings: PreviewSettings): Promise<PreviewSettings>;

  /** Deletes the Project's settings; deleting none changes nothing. */
  delete(projectId: string): Promise<void>;
}
