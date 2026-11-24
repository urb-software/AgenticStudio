import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  RUN_PREVIEW_SOURCES,
  type RunPreviewSources,
} from '../../../../projects/contracts/index.js';
import { PreviewOperation } from '../../../domain/entities/preview-operation.js';
import {
  PreviewRepositoryNotReadyError,
  ProjectNotFoundError,
} from '../../../domain/errors/preview-settings-errors.js';
import { PreviewSettingsMissingError } from '../../../domain/errors/preview-operation-errors.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../../../domain/repositories/preview-operation-repository.js';
import {
  PREVIEW_SETTINGS_REPOSITORY,
  type PreviewSettingsRepository,
} from '../../../domain/repositories/preview-settings-repository.js';
import { PreviewCommit } from '../../../domain/value-objects/preview-commit.js';
import { PreviewComposeFile } from '../../../domain/value-objects/preview-compose-file.js';
import { PreviewLimits } from '../../../domain/value-objects/preview-limits.js';
import type { PreviewOperationKind } from '../../../domain/value-objects/preview-operation-kind.js';
import { PreviewPort } from '../../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../../domain/value-objects/preview-service.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { PREVIEW_LIMITS, type PreviewLimitsSettings } from '../../ports/preview-limits-settings.js';

export interface RequestPreviewOperationInput {
  projectId: string;
  kind: PreviewOperationKind;
}

export interface RequestPreviewOperationResult {
  operationId: string;
}

/**
 * Asks the environment controller to build, stop, remove the data of, or report on a Project's
 * Preview. A build snapshots the settings, the Integration branch's commit and the limits. No
 * HTTP route calls it: it is the seam for the features that trigger a Preview.
 * Throws {@link ProjectNotFoundError}, {@link PreviewRepositoryNotReadyError} and
 * {@link PreviewSettingsMissingError}.
 */
@Injectable()
export class RequestPreviewOperationHandler {
  constructor(
    @Inject(RUN_PREVIEW_SOURCES) private readonly sources: RunPreviewSources,
    @Inject(PREVIEW_SETTINGS_REPOSITORY) private readonly settings: PreviewSettingsRepository,
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(PREVIEW_LIMITS) private readonly limits: PreviewLimitsSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: RequestPreviewOperationInput): Promise<RequestPreviewOperationResult> {
    const { projectId, kind } = input;
    const source = await this.sources.status(projectId);
    if (source.status === 'project_not_found') throw new ProjectNotFoundError();
    const id = randomUUID();
    const now = this.clock.now();
    if (kind !== 'build') {
      await this.operations.add(PreviewOperation.requestOther({ id, projectId, kind, now }));
      return { operationId: id };
    }
    if (source.status !== 'ready') throw new PreviewRepositoryNotReadyError(source.status);
    const settings = await this.settings.find(projectId);
    if (settings === null) throw new PreviewSettingsMissingError();
    await this.operations.add(
      PreviewOperation.requestBuild({
        id,
        projectId,
        commit: PreviewCommit.of(source.commit),
        composeFile: PreviewComposeFile.of(settings.composeFile),
        service: PreviewService.of(settings.service),
        port: PreviewPort.of(settings.port),
        limits: PreviewLimits.of(this.limits),
        now,
      }),
    );
    return { operationId: id };
  }
}
