import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  RUN_PREVIEW_SOURCES,
  type RunPreviewSources,
} from '../../../../projects/contracts/index.js';
import { PreviewOperation } from '../../../domain/entities/preview-operation.js';
import { PreviewSettingsMissingError } from '../../../domain/errors/preview-operation-errors.js';
import {
  PreviewBuildRunningError,
  PreviewControllerUnavailableError,
  PreviewRepositoryNotReadyError,
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
import { PreviewCommit } from '../../../domain/value-objects/preview-commit.js';
import { PreviewLimits } from '../../../domain/value-objects/preview-limits.js';
import type { PreviewOperationKind } from '../../../domain/value-objects/preview-operation-kind.js';
import { PreviewPort } from '../../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../../domain/value-objects/preview-service.js';
import { PreviewState } from '../../../domain/value-objects/preview-state.js';
import { PreviewComposeFile } from '../../../domain/value-objects/preview-compose-file.js';
import { type PreviewBuildView, previewBuildView } from '../../preview-view.js';
import { PreviewComposeJudge } from '../../preview-compose-judge.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { CONTROLLER_PRESENCE, type ControllerPresence } from '../../ports/controller-presence.js';
import {
  PREVIEW_OPERATION_SETTINGS,
  type PreviewOperationSettings,
} from '../../ports/preview-operation-settings.js';
import { PREVIEW_LIMITS, type PreviewLimitsSettings } from '../../ports/preview-limits-settings.js';

export interface RequestPreviewOperationInput {
  projectId: string;
  kind: PreviewOperationKind;
}

export interface RequestPreviewOperationResult {
  operationId: string;
  /** The requested build; `null` for the other kinds. */
  build: PreviewBuildView | null;
}

/** Asks the controller for a build, stop, data removal or state, checking a build as backend.md section 7 lists. */
@Injectable()
export class RequestPreviewOperationHandler {
  constructor(
    @Inject(RUN_PREVIEW_SOURCES) private readonly sources: RunPreviewSources,
    @Inject(PREVIEW_SETTINGS_REPOSITORY) private readonly settings: PreviewSettingsRepository,
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(PREVIEW_LIMITS) private readonly limits: PreviewLimitsSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly judge: PreviewComposeJudge,
    @Inject(CONTROLLER_PRESENCE) private readonly presence: ControllerPresence,
    @Inject(PREVIEW_OPERATION_SETTINGS)
    private readonly operationSettings: PreviewOperationSettings,
  ) {}

  async execute(input: RequestPreviewOperationInput): Promise<RequestPreviewOperationResult> {
    const { projectId, kind } = input;
    const source = await this.sources.status(projectId);
    if (source.status === 'project_not_found') throw new ProjectNotFoundError();
    const id = randomUUID();
    const now = this.clock.now();
    if (kind !== 'build') {
      await this.operations.add(PreviewOperation.requestOther({ id, projectId, kind, now }));
      return { operationId: id, build: null };
    }
    const settings = await this.settings.find(projectId);
    if (settings === null) throw new PreviewSettingsMissingError();
    if (source.status !== 'ready') throw new PreviewRepositoryNotReadyError(source.status);
    if (!this.presence.availability(this.operationSettings.leaseSeconds).connected(now)) {
      throw new PreviewControllerUnavailableError();
    }
    const facts = await this.operations.findPreviewFacts(projectId);
    if (PreviewState.of({ configured: true, ...facts }).buildActive) {
      throw new PreviewBuildRunningError();
    }
    const composeFile = PreviewComposeFile.of(settings.composeFile);
    const service = PreviewService.of(settings.service);
    const port = PreviewPort.of(settings.port);
    const verdict = await this.judge.judge({ projectId, composeFile, service, port });
    const operation = PreviewOperation.requestBuild({
      id,
      projectId,
      commit: PreviewCommit.of(verdict.commit),
      composeFile,
      service,
      port,
      limits: PreviewLimits.of(this.limits),
      now,
    });
    await this.operations.add(operation);
    return { operationId: id, build: previewBuildView(operation) };
  }
}
