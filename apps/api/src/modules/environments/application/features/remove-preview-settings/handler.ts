import { Inject, Injectable } from '@nestjs/common';
import {
  PROJECT_KINDS,
  type ProjectKinds,
  RUN_PREVIEW_SOURCES,
  type RunPreviewSources,
} from '../../../../projects/contracts/index.js';
import {
  DefinitionsProjectError,
  ProjectNotFoundError,
} from '../../../domain/errors/preview-settings-errors.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../../../domain/repositories/preview-operation-repository.js';
import {
  PREVIEW_SETTINGS_REPOSITORY,
  type PreviewSettingsRepository,
} from '../../../domain/repositories/preview-settings-repository.js';
import { PreviewState } from '../../../domain/value-objects/preview-state.js';

export interface RemovePreviewSettingsInput {
  projectId: string;
}

/**
 * Removing settings that are not set changes nothing. Throws `ProjectNotFoundError`,
 * `DefinitionsProjectError`, `PreviewRunningError` and `PreviewBuildRunningError`.
 */
@Injectable()
export class RemovePreviewSettingsHandler {
  constructor(
    @Inject(PROJECT_KINDS) private readonly kinds: ProjectKinds,
    @Inject(RUN_PREVIEW_SOURCES) private readonly sources: RunPreviewSources,
    @Inject(PREVIEW_SETTINGS_REPOSITORY) private readonly settings: PreviewSettingsRepository,
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
  ) {}

  async execute(input: RemovePreviewSettingsInput): Promise<void> {
    const { projectId } = input;
    if ((await this.kinds.kindOf(projectId)) === 'definitions') throw new DefinitionsProjectError();
    if ((await this.sources.status(projectId)).status === 'project_not_found') {
      throw new ProjectNotFoundError();
    }
    const settings = await this.settings.find(projectId);
    if (!settings) return;
    const facts = await this.operations.findPreviewFacts(projectId);
    const state = PreviewState.of({ configured: true, ...facts });
    settings.remove({ previewRunning: state.running !== null, buildActive: state.buildActive });
    await this.settings.delete(projectId);
  }
}
