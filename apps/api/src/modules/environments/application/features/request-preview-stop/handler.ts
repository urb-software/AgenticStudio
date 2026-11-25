import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PROJECT_KINDS, type ProjectKinds } from '../../../../projects/contracts/index.js';
import { DefinitionsProjectError } from '../../../domain/errors/preview-settings-errors.js';
import { PreviewOperation } from '../../../domain/entities/preview-operation.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../../../domain/repositories/preview-operation-repository.js';
import { PreviewState } from '../../../domain/value-objects/preview-state.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { PreviewBuildRequests } from '../../preview-build-requests.js';

export interface RequestPreviewStopInput {
  projectId: string;
}

export interface RequestPreviewStopResult {
  operationId: string;
}

/**
 * Asks the controller to stop a running Preview. Throws `ProjectNotFoundError`,
 * `DefinitionsProjectError`, `PreviewControllerUnavailableError`, `PreviewBuildRunningError`, `PreviewBusyError` and
 * `PreviewNotRunningError`.
 */
@Injectable()
export class RequestPreviewStopHandler {
  constructor(
    @Inject(PROJECT_KINDS) private readonly kinds: ProjectKinds,
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly builds: PreviewBuildRequests,
  ) {}

  async execute(input: RequestPreviewStopInput): Promise<RequestPreviewStopResult> {
    const { projectId } = input;
    if ((await this.kinds.kindOf(projectId)) === 'definitions') throw new DefinitionsProjectError();
    await this.builds.assertProject(projectId);
    this.builds.assertControllerConnected();
    const id = randomUUID();
    const now = this.clock.now();
    await this.operations.request(projectId, (facts) => {
      const refusal = PreviewState.of({ configured: true, ...facts.preview }).stopRefusal();
      if (refusal !== null) throw refusal;
      return [PreviewOperation.requestOther({ id, projectId, kind: 'stop', now })];
    });
    return { operationId: id };
  }
}
