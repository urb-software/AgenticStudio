import { Inject, Injectable } from '@nestjs/common';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOccupation,
  type PreviewOperationRepository,
} from '../../../domain/repositories/preview-operation-repository.js';
import {
  PREVIEW_RUNNING_LIMIT,
  type PreviewRunningLimitSettings,
} from '../../ports/preview-running-limit.js';

export interface ListPreviewsResult {
  limit: number;
  /** The Projects that take a place of the limit, by Project id. */
  previews: PreviewOccupation[];
}

/** The running limit and the Projects that take its places. */
@Injectable()
export class ListPreviewsHandler {
  constructor(
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(PREVIEW_RUNNING_LIMIT) private readonly limit: PreviewRunningLimitSettings,
  ) {}

  async execute(): Promise<ListPreviewsResult> {
    return {
      limit: this.limit.maxRunning,
      previews: await this.operations.findOccupyingProjects(),
    };
  }
}
