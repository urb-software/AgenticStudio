import { Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import type { MergedRun, MergedRunPreviews, PreviewOfMerge } from '../../contracts/index.js';
import { GetPreviewOfMergeHandler } from '../../application/features/get-preview-of-merge/handler.js';
import { RecordMergeRebuildHandler } from '../../application/features/record-merge-rebuild/handler.js';

/**
 * The driving adapter for another module's call through `contracts/`: it maps the call to the
 * handlers and holds no rule. A failure of `merged` becomes a redacted log line.
 */
@Injectable()
export class EnvironmentsMergedRunPreviews implements MergedRunPreviews {
  private readonly logger = new Logger('MergedRunPreviews');

  constructor(
    private readonly record: RecordMergeRebuildHandler,
    private readonly preview: GetPreviewOfMergeHandler,
  ) {}

  async merged(merge: MergedRun): Promise<void> {
    try {
      await this.record.execute(merge);
    } catch (error) {
      this.logger.warn(
        'A merge could not be recorded for the Preview; it is reported there only.',
        redactSecrets(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  forMerge(
    projectId: string,
    runId: string,
    mergedCommit: string,
    mergedAt: Date,
  ): Promise<PreviewOfMerge> {
    return this.preview.execute({ projectId, runId, mergedCommit, mergedAt });
  }
}
