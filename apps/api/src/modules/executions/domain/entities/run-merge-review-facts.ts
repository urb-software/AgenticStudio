import type { LogRedaction } from '../value-objects/log-redaction.js';
import type { MergeReviewFileInput } from '../value-objects/merge-review-file.js';

/** The limits a computed diff is kept under; the byte limits count the stored JSON. */
export interface MergeReviewLimitsFacts {
  readonly filesMax: number;
  readonly filePatchMaxBytes: number;
  readonly patchMaxBytes: number;
  readonly totalMaxBytes: number;
}

/** What a finished diff gives a review. */
export interface MergeReviewDiffFacts {
  readonly runCommit: string;
  readonly integrationCommit: string;
  readonly files: readonly MergeReviewFileInput[];
  readonly truncated: boolean;
  readonly redaction: LogRedaction;
  readonly limits: MergeReviewLimitsFacts;
}
