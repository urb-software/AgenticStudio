import { validateCompose } from '@agentic-studio/compose-validation';
import { Inject, Injectable } from '@nestjs/common';
import {
  INTEGRATION_FILE_MAX_BYTES,
  RUN_PREVIEW_SOURCES,
  type RunPreviewSources,
} from '../../projects/contracts/index.js';
import {
  PreviewRefusedError,
  PreviewRepositoryNotReadyError,
  PreviewSourceUnavailableError,
  ProjectNotFoundError,
} from '../domain/errors/preview-settings-errors.js';
import {
  InvalidPreviewComposeFileError,
  PreviewComposeFile,
} from '../domain/value-objects/preview-compose-file.js';
import type { PreviewPort } from '../domain/value-objects/preview-port.js';
import type { PreviewService } from '../domain/value-objects/preview-service.js';

const COMPOSE_FILE_MISSING =
  'The Compose file is not in the Integration branch, or is not a regular file.';
const COMPOSE_FILE_TOO_LARGE = `The Compose file is larger than ${INTEGRATION_FILE_MAX_BYTES / 1024} KiB.`;

/** What the judged file is: the commit it was read at and the ports the validation removes. */
export interface PreviewComposeVerdict {
  commit: string;
  removedPorts: { service: string; place: string }[];
}

/** Reads the Compose file from the Integration branch and judges it; the save and the build request share it. */
@Injectable()
export class PreviewComposeJudge {
  constructor(@Inject(RUN_PREVIEW_SOURCES) private readonly sources: RunPreviewSources) {}

  /** An unsafe path is refused whatever the Repository's state. Throws {@link PreviewRefusedError}. */
  composeFile(path: string): PreviewComposeFile {
    try {
      return PreviewComposeFile.of(path);
    } catch (error) {
      if (error instanceof InvalidPreviewComposeFileError) {
        throw this.refusedAtFile('invalid_path', error.message);
      }
      throw error;
    }
  }

  /**
   * Throws {@link PreviewRefusedError}, {@link PreviewRepositoryNotReadyError},
   * {@link PreviewSourceUnavailableError} and {@link ProjectNotFoundError}.
   */
  async judge(input: {
    projectId: string;
    composeFile: PreviewComposeFile;
    service: PreviewService;
    port: PreviewPort;
  }): Promise<PreviewComposeVerdict> {
    const { projectId, composeFile, service, port } = input;
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
    return {
      commit: read.commit,
      removedPorts: verdict.removedPorts.map(({ service: name, place }) => ({
        service: name,
        place,
      })),
    };
  }

  private refusedAtFile(code: string, message: string): PreviewRefusedError {
    return new PreviewRefusedError([{ code, place: 'composeFile', message }]);
  }
}
