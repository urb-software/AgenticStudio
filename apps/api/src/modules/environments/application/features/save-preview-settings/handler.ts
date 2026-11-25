import { Inject, Injectable } from '@nestjs/common';
import {
  RUN_PREVIEW_SOURCES,
  type RunPreviewSources,
} from '../../../../projects/contracts/index.js';
import { PROJECT_KINDS, type ProjectKinds } from '../../../../projects/contracts/index.js';
import { PreviewSettings } from '../../../domain/entities/preview-settings.js';
import {
  DefinitionsProjectError,
  PreviewRepositoryNotReadyError,
  ProjectNotFoundError,
} from '../../../domain/errors/preview-settings-errors.js';
import {
  PREVIEW_SETTINGS_REPOSITORY,
  type PreviewSettingsRepository,
} from '../../../domain/repositories/preview-settings-repository.js';
import { PreviewPort } from '../../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../../domain/value-objects/preview-service.js';
import { PREVIEW_DOMAIN_SETTINGS, type PreviewDomainSettings } from '../../ports/preview-domain.js';
import { PreviewComposeJudge } from '../../preview-compose-judge.js';
import { PreviewStateReader } from '../../preview-state-reader.js';
import { previewView, type PreviewView } from '../../preview-view.js';

export interface SavePreviewSettingsInput {
  projectId: string;
  composeFile: string;
  service: string;
  port: number;
}

export type SavePreviewSettingsResult = PreviewView & {
  /** The published ports the validation removed from the Compose file. */
  removedPorts: { service: string; place: string }[];
};

/**
 * Saves only what the Compose validation accepts, judged on the file as the Clone holds it.
 * Throws `DefinitionsProjectError` for the definitions Repository.
 */
@Injectable()
export class SavePreviewSettingsHandler {
  constructor(
    @Inject(PROJECT_KINDS) private readonly kinds: ProjectKinds,
    @Inject(RUN_PREVIEW_SOURCES) private readonly sources: RunPreviewSources,
    @Inject(PREVIEW_SETTINGS_REPOSITORY) private readonly settings: PreviewSettingsRepository,
    @Inject(PREVIEW_DOMAIN_SETTINGS) private readonly domain: PreviewDomainSettings,
    private readonly judge: PreviewComposeJudge,
    private readonly states: PreviewStateReader,
  ) {}

  async execute(input: SavePreviewSettingsInput): Promise<SavePreviewSettingsResult> {
    const { projectId } = input;
    if ((await this.kinds.kindOf(projectId)) === 'definitions') throw new DefinitionsProjectError();
    const source = await this.sources.status(projectId);
    if (source.status === 'project_not_found') throw new ProjectNotFoundError();
    const composeFile = this.judge.composeFile(input.composeFile);
    if (source.status !== 'ready') throw new PreviewRepositoryNotReadyError(source.status);

    const service = PreviewService.of(input.service);
    const port = PreviewPort.of(input.port);
    const verdict = await this.judge.judge({ projectId, composeFile, service, port });

    const saved = await this.settings.save(
      PreviewSettings.create({ projectId, composeFile, service, port, now: new Date() }),
    );
    return {
      ...previewView({
        projectId,
        settings: saved,
        domain: this.domain.domain,
        repositoryReason: null,
        commit: source.commit,
        stateView: await this.states.read({
          projectId,
          configured: true,
          domain: this.domain.domain,
          source: { ready: true, commit: source.commit, fetchedAt: source.fetchedAt },
        }),
      }),
      removedPorts: verdict.removedPorts,
    };
  }
}
