import type { MergeReviewFileData } from '../value-objects/merge-review-file.js';
import type { StoredMergeReviewState } from '../value-objects/merge-review-state.js';

/** What a Run's merge review holds, to restore it from. */
export interface RunMergeReviewData {
  readonly runId: string;
  readonly state: StoredMergeReviewState;
  readonly runCommit: string | null;
  readonly integrationCommit: string | null;
  readonly files: readonly MergeReviewFileData[];
  readonly truncated: boolean;
  readonly failure: string | null;
  readonly requestedAt: Date;
  readonly completedAt: Date | null;
}
