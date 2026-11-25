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

export interface RequestPreviewResetDataInput {
  projectId: string;
}

export interface RequestPreviewResetDataResult {
  /** The data removal. */
  operationId: string;
  /** The rebuild of what ran, requested with it; `null` when nothing ran. */
  buildId: string | null;
}

/**
 * Removes the Preview's data for good; a running Preview is rebuilt from its own build in the same
 * transaction, after the removal. Throws `ProjectNotFoundError`, `DefinitionsProjectError`,
 * `PreviewControllerUnavailableError`, `PreviewBuildRunningError` and `PreviewBusyError`.
 */
@Injectable()
export class RequestPreviewResetDataHandler {
  constructor(
    @Inject(PROJECT_KINDS) private readonly kinds: ProjectKinds,
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly builds: PreviewBuildRequests,
  ) {}

  async execute(input: RequestPreviewResetDataInput): Promise<RequestPreviewResetDataResult> {
    const { projectId } = input;
    if ((await this.kinds.kindOf(projectId)) === 'definitions') throw new DefinitionsProjectError();
    await this.builds.assertProject(projectId);
    this.builds.assertControllerConnected();
    const id = randomUUID();
    const now = this.clock.now();
    let buildId: string | null = null;
    await this.operations.request(projectId, (facts) => {
      const state = PreviewState.of({ configured: true, ...facts.preview });
      const refusal = state.resetRefusal();
      if (refusal !== null) throw refusal;
      const removal = PreviewOperation.requestOther({ id, projectId, kind: 'remove_data', now });
      const running = facts.preview.runningChange;
      if (state.running === null || running === null || running.build === null) {
        return [removal];
      }
      const rebuild = this.builds.operationOf(
        this.builds.prepareFromBuild(projectId, running.build),
        1,
      );
      buildId = rebuild.id;
      return [removal, rebuild];
    });
    return { operationId: id, buildId };
  }
}
