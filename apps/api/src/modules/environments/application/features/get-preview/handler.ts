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
import { PREVIEW_DOMAIN_SETTINGS, type PreviewDomainSettings } from '../../ports/preview-domain.js';
import { previewView, type PreviewView } from '../../preview-view.js';
import { PreviewStateReader } from '../../preview-state-reader.js';

export interface GetPreviewInput {
  projectId: string;
}

export type GetPreviewResult = PreviewView;

/** Throws {@link ProjectNotFoundError}. */
@Injectable()
export class GetPreviewHandler {
  constructor(
    @Inject(RUN_PREVIEW_SOURCES) private readonly sources: RunPreviewSources,
    @Inject(PREVIEW_SETTINGS_REPOSITORY) private readonly settings: PreviewSettingsRepository,
    @Inject(PREVIEW_DOMAIN_SETTINGS) private readonly domain: PreviewDomainSettings,
    private readonly states: PreviewStateReader,
  ) {}

  async execute(input: GetPreviewInput): Promise<GetPreviewResult> {
    const { projectId } = input;
    const source = await this.sources.status(projectId);
    if (source.status === 'project_not_found') throw new ProjectNotFoundError();
    const settings = await this.settings.find(projectId);
    return previewView({
      projectId,
      settings,
      domain: this.domain.domain,
      repositoryReason: source.status === 'ready' ? null : source.status,
      commit: source.status === 'ready' ? source.commit : null,
      stateView: await this.states.read({
        projectId,
        configured: settings !== null,
        domain: this.domain.domain,
        source:
          source.status === 'ready'
            ? { ready: true, commit: source.commit, fetchedAt: source.fetchedAt }
            : { ready: false },
      }),
    });
  }
}
