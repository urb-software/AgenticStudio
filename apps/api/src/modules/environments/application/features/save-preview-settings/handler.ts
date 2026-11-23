import { validateCompose } from '@agentic-studio/compose-validation';
import { Inject, Injectable } from '@nestjs/common';
import {
  INTEGRATION_FILE_MAX_BYTES,
  RUN_PREVIEW_SOURCES,
  type RunPreviewSources,
} from '../../../../projects/contracts/index.js';
import { PreviewSettings } from '../../../domain/entities/preview-settings.js';
import {
  PreviewRefusedError,
  PreviewRepositoryNotReadyError,
  PreviewSourceUnavailableError,
  ProjectNotFoundError,
} from '../../../domain/errors/preview-settings-errors.js';
import {
  PREVIEW_SETTINGS_REPOSITORY,
  type PreviewSettingsRepository,
} from '../../../domain/repositories/preview-settings-repository.js';
import {
  InvalidPreviewComposeFileError,
  PreviewComposeFile,
} from '../../../domain/value-objects/preview-compose-file.js';
import { PreviewPort } from '../../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../../domain/value-objects/preview-service.js';
import { PREVIEW_DOMAIN_SETTINGS, type PreviewDomainSettings } from '../../ports/preview-domain.js';
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

/** Fixed wording of the refusals this flow adds to the validation's own. */
const COMPOSE_FILE_MISSING =
  'The Compose file is not in the Integration branch, or is not a regular file.';
const COMPOSE_FILE_TOO_LARGE = `The Compose file is larger than ${INTEGRATION_FILE_MAX_BYTES / 1024} KiB.`;

/**
 * Saves only what the Compose validation accepts, judged on the file as the Clone holds it.
 */
@Injectable()
export class SavePreviewSettingsHandler {
  constructor(
    @Inject(RUN_PREVIEW_SOURCES) private readonly sources: RunPreviewSources,
    @Inject(PREVIEW_SETTINGS_REPOSITORY) private readonly settings: PreviewSettingsRepository,
    @Inject(PREVIEW_DOMAIN_SETTINGS) private readonly domain: PreviewDomainSettings,
  ) {}

  async execute(input: SavePreviewSettingsInput): Promise<SavePreviewSettingsResult> {
    const { projectId } = input;
    const source = await this.sources.status(projectId);
    if (source.status === 'project_not_found') throw new ProjectNotFoundError();
    // An unsafe path is refused whatever the Repository's state.
    const composeFile = this.composeFileOf(input.composeFile);
    if (source.status !== 'ready') throw new PreviewRepositoryNotReadyError(source.status);

    const service = PreviewService.of(input.service);
    const port = PreviewPort.of(input.port);

    const read = await this.sources.readIntegrationFile(projectId, composeFile.value);
    switch (read.status) {
      case 'found':
        break;
      case 'missing':
        throw this.refusedAtFile('compose_file_missing', COMPOSE_FILE_MISSING);
      case 'too_large':
        throw this.refusedAtFile('compose_file_too_large', COMPOSE_FILE_TOO_LARGE);
      case 'project_not_found':
        throw new ProjectNotFoundError();
      case 'repository_not_ready':
      case 'unsupported_platform':
        throw new PreviewRepositoryNotReadyError(read.status);
      case 'failed':
        throw new PreviewSourceUnavailableError();
    }

    const verdict = validateCompose({
      text: read.text,
      entryService: service.value,
      entryPort: port.value,
    });
    if (verdict.status === 'refused') {
      throw new PreviewRefusedError(
        verdict.refusals.map(({ code, place, message }) => ({ code, place, message })),
      );
    }

    const saved = await this.settings.save(
      PreviewSettings.create({ projectId, composeFile, service, port, now: new Date() }),
    );
    return {
      ...previewView({
        projectId,
        settings: saved,
        domain: this.domain.domain,
        repositoryReason: null,
      }),
      removedPorts: verdict.removedPorts.map(({ service: name, place }) => ({
        service: name,
        place,
      })),
    };
  }

  private composeFileOf(path: string): PreviewComposeFile {
    try {
      return PreviewComposeFile.of(path);
    } catch (error) {
      if (error instanceof InvalidPreviewComposeFileError) {
        throw this.refusedAtFile('invalid_path', error.message);
      }
      throw error;
    }
  }

  private refusedAtFile(code: string, message: string): PreviewRefusedError {
    return new PreviewRefusedError([{ code, place: 'composeFile', message }]);
  }
}
