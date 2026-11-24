import { Inject, Injectable } from '@nestjs/common';
import {
  RUN_PREVIEW_SOURCES,
  type RunPreviewSources,
} from '../../../../projects/contracts/index.js';
import { PreviewBuildNotFoundError } from '../../../domain/errors/preview-operation-errors.js';
import { ProjectNotFoundError } from '../../../domain/errors/preview-settings-errors.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../../../domain/repositories/preview-operation-repository.js';
import type { PreviewLogStream } from '../../../domain/value-objects/preview-log-line.js';
import {
  PREVIEW_OPERATION_LOG,
  type PreviewOperationLog,
} from '../../ports/preview-operation-log.js';

export interface GetPreviewBuildEventsInput {
  projectId: string;
  buildId: string;
  after: number;
  limit: number;
}

export interface GetPreviewBuildEventsResult {
  events: {
    seq: number;
    at: Date;
    stream: PreviewLogStream;
    text: string;
    truncated: boolean;
    redacted: boolean;
  }[];
  /** The `after` of the following page; absent on the last page. */
  next?: number;
  /** The build was over before the lines were read: no line will be added. */
  final: boolean;
  /** The log reached its size cap. */
  truncated: boolean;
}

/**
 * One page of a build's stored log, already redacted when it was stored. An unknown id, an
 * operation that is not a build and another Project's build are the same {@link PreviewBuildNotFoundError}.
 */
@Injectable()
export class GetPreviewBuildEventsHandler {
  constructor(
    @Inject(RUN_PREVIEW_SOURCES) private readonly sources: RunPreviewSources,
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(PREVIEW_OPERATION_LOG) private readonly log: PreviewOperationLog,
  ) {}

  async execute(input: GetPreviewBuildEventsInput): Promise<GetPreviewBuildEventsResult> {
    const { projectId, buildId, after, limit } = input;
    if ((await this.sources.status(projectId)).status === 'project_not_found') {
      throw new ProjectNotFoundError();
    }
    const build = await this.operations.find(buildId);
    if (build === null || build.kind !== 'build' || build.projectId !== projectId) {
      throw new PreviewBuildNotFoundError();
    }
    // Read before the lines: a build that is final here has all its lines stored.
    const final = build.status === 'succeeded' || build.status === 'failed';
    const page = await this.log.page(buildId, after, limit);
    const last = page.lines.at(-1);
    return {
      events: page.lines.map((line) => ({
        seq: line.seq,
        at: line.at,
        stream: line.stream,
        text: line.text,
        truncated: line.truncated,
        redacted: line.redacted,
      })),
      ...(page.hasMore && last !== undefined ? { next: last.seq } : {}),
      final,
      truncated: build.log.truncated,
    };
  }
}
