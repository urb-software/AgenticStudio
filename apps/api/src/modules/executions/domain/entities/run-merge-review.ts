import type { LogRedaction } from '../value-objects/log-redaction.js';
import { MergeReviewDeadline } from '../value-objects/merge-review-deadline.js';
import { MergeReviewFile } from '../value-objects/merge-review-file.js';
import type {
  MergeReviewState,
  StoredMergeReviewState,
} from '../value-objects/merge-review-state.js';
import type { RunMergeReviewData } from './run-merge-review-data.js';
import type { MergeReviewDiffFacts } from './run-merge-review-facts.js';

/**
 * What the Integration branch would gain from a Run's branch, as Studio computed it. A change
 * returns the next review; the store keeps one per Run.
 */
export class RunMergeReview {
  static readonly FAILURE_MAX_LENGTH = 2000;
  static readonly INTERRUPTED = 'The review was interrupted before it finished. Request it again.';
  static readonly CONFLICTS = 'The Run branch conflicts with the Integration branch.';

  private constructor(
    readonly runId: string,
    readonly storedState: StoredMergeReviewState,
    readonly runCommit: string | null,
    readonly integrationCommit: string | null,
    readonly files: readonly MergeReviewFile[],
    readonly truncated: boolean,
    readonly failure: string | null,
    readonly requestedAt: Date,
    readonly completedAt: Date | null,
  ) {}

  /** A new review of the Run, being prepared. */
  static request(runId: string, now: Date): RunMergeReview {
    return new RunMergeReview(runId, 'preparing', null, null, [], false, null, now, null);
  }

  static restore(data: RunMergeReviewData): RunMergeReview {
    return new RunMergeReview(
      data.runId,
      data.state,
      data.runCommit,
      data.integrationCommit,
      data.files.map((file) => MergeReviewFile.restore(file)),
      data.truncated,
      data.failure,
      data.requestedAt,
      data.completedAt,
    );
  }

  /**
   * Redacts the patches with the Run's secret values, then applies the limits to what is stored:
   * a patch that no longer fits is left out (its file is `cut`), and the review says it is cut.
   */
  ready(diff: MergeReviewDiffFacts, now: Date): RunMergeReview {
    const { limits } = diff;
    let truncated = diff.truncated || diff.files.length > limits.filesMax;
    let storedBytes = 0;
    const files = diff.files.slice(0, limits.filesMax).map((raw) => {
      let file = MergeReviewFile.load(raw, diff.redaction, limits.filePatchMaxBytes);
      if (storedBytes + file.storedBytes > limits.totalMaxBytes && file.patch !== undefined) {
        file = file.withoutPatch();
        truncated = true;
      }
      storedBytes += file.storedBytes;
      return file;
    });
    return new RunMergeReview(
      this.runId,
      'ready',
      diff.runCommit,
      diff.integrationCommit,
      files,
      truncated,
      null,
      this.requestedAt,
      now,
    );
  }

  /** The reason is redacted and cut to what is stored. */
  failed(reason: string, redaction: LogRedaction, now: Date): RunMergeReview {
    return new RunMergeReview(
      this.runId,
      'failed',
      null,
      null,
      [],
      false,
      redaction.text(reason).slice(0, RunMergeReview.FAILURE_MAX_LENGTH),
      this.requestedAt,
      now,
    );
  }

  /** `latestHead`: the newest commit of the Run branch Studio knows of, or `null`. */
  stateAt(now: Date, latestHead: string | null): MergeReviewState {
    if (this.storedState === 'preparing') {
      return MergeReviewDeadline.at(now).isOver(this.requestedAt) ? 'failed' : 'preparing';
    }
    if (this.storedState === 'failed') return 'failed';
    const behind =
      latestHead !== null && latestHead.toLowerCase() !== this.runCommit?.toLowerCase();
    return behind ? 'out_of_date' : 'ready';
  }

  /** Why the review failed, as the page shows it; a lost preparation says so. */
  failureAt(now: Date): string | null {
    if (this.storedState === 'preparing') {
      return MergeReviewDeadline.at(now).isOver(this.requestedAt)
        ? RunMergeReview.INTERRUPTED
        : null;
    }
    return this.failure;
  }

  file(path: string): MergeReviewFile | undefined {
    return this.files.find((file) => file.path === path);
  }
}
