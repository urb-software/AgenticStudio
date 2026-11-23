import { Inject, Injectable } from '@nestjs/common';
import {
  RUN_PREVIEW_SOURCES,
  type RunPreviewSources,
} from '../../../../projects/contracts/index.js';
import { ProjectNotFoundError } from '../../../domain/errors/preview-settings-errors.js';
import {
  PREVIEW_SETTINGS_REPOSITORY,
  type PreviewSettingsRepository,
} from '../../../domain/repositories/preview-settings-repository.js';

export interface RemovePreviewSettingsInput {
  projectId: string;
}

/** Removing settings that are not set changes nothing. */
@Injectable()
export class RemovePreviewSettingsHandler {
  constructor(
    @Inject(RUN_PREVIEW_SOURCES) private readonly sources: RunPreviewSources,
    @Inject(PREVIEW_SETTINGS_REPOSITORY) private readonly settings: PreviewSettingsRepository,
  ) {}

  async execute(input: RemovePreviewSettingsInput): Promise<void> {
    const { projectId } = input;
    if ((await this.sources.status(projectId)).status === 'project_not_found') {
      throw new ProjectNotFoundError();
    }
    const settings = await this.settings.find(projectId);
    if (!settings) return;
    settings.remove({ previewRunning: false });
    await this.settings.delete(projectId);
  }
}
