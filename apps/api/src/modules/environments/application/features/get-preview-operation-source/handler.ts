import { Inject, Injectable } from '@nestjs/common';
import {
  RUN_PREVIEW_SOURCES,
  type RunPreviewSources,
} from '../../../../projects/contracts/index.js';
import {
  PreviewOperationNotABuildError,
  PreviewOperationNotFoundError,
} from '../../../domain/errors/preview-operation-errors.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../../../domain/repositories/preview-operation-repository.js';
import { PreviewArchiveLimit } from '../../../domain/value-objects/preview-archive-limit.js';

export interface GetPreviewOperationSourceInput {
  operationId: string;
  controllerId: string;
}

/**
 * `ready`: the commit's archive, held in a temporary file until `close` (call it in a `finally`).
 * `source_unavailable`: the commit or the Repository cannot be read now. `source_too_large`: the
 * archive passed the limit.
 */
export type GetPreviewOperationSourceResult =
  | {
      status: 'ready';
      sizeBytes: number;
      chunks: AsyncIterable<Uint8Array>;
      close(): Promise<void>;
    }
  | { status: 'source_unavailable' }
  | { status: 'source_too_large' };

/**
 * The source of a claimed build. Throws {@link PreviewOperationNotFoundError},
 * `PreviewOperationNotHeldError` and {@link PreviewOperationNotABuildError}.
 */
@Injectable()
export class GetPreviewOperationSourceHandler {
  constructor(
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(RUN_PREVIEW_SOURCES) private readonly sources: RunPreviewSources,
  ) {}

  async execute(input: GetPreviewOperationSourceInput): Promise<GetPreviewOperationSourceResult> {
    const operation = await this.operations.find(input.operationId);
    if (operation === null) throw new PreviewOperationNotFoundError();
    operation.assertHeldBy(input.controllerId);
    if (operation.build === null) throw new PreviewOperationNotABuildError();
    const opened = await this.sources.openArchive(
      operation.projectId,
      operation.build.commit,
      PreviewArchiveLimit.standard().maxBytes,
    );
    if (opened.status === 'ready') return opened;
    return opened.status === 'too_large'
      ? { status: 'source_too_large' }
      : { status: 'source_unavailable' };
  }
}
