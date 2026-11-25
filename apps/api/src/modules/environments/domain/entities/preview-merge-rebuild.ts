import type { PreviewMergeRebuildData } from './preview-merge-rebuild-data.js';
import type { PreviewMergeRebuildFacts } from './preview-merge-rebuild-facts.js';

const FAILURE_MAX_LENGTH = 2000;

/**
 * The rebuild a merge through Studio asked of a Project's Preview, until the Preview carries it
 * out, drops it or gives it up. A newer merge replaces it.
 */
export class PreviewMergeRebuild {
  readonly projectId: string;
  readonly runId: string;
  readonly mergedCommit: string;
  readonly mergedAt: Date;
  readonly fetchStartedAt: Date;
  readonly recordedAt: Date;
  private current: PreviewMergeRebuildData;

  private constructor(data: PreviewMergeRebuildData) {
    this.projectId = data.projectId;
    this.runId = data.runId;
    this.mergedCommit = data.mergedCommit;
    this.mergedAt = data.mergedAt;
    this.fetchStartedAt = data.fetchStartedAt;
    this.recordedAt = data.recordedAt;
    this.current = data;
  }

  /** A waiting rebuild; storing it replaces the Project's earlier one, so the latest merge wins. */
  static record(facts: PreviewMergeRebuildFacts): PreviewMergeRebuild {
    return new PreviewMergeRebuild({
      projectId: facts.projectId,
      runId: facts.runId,
      mergedCommit: facts.mergedCommit,
      mergedAt: facts.mergedAt,
      fetchStartedAt: facts.fetchStartedAt,
      recordedAt: facts.now,
      failure: null,
      failedAt: null,
    });
  }

  static restore(data: PreviewMergeRebuildData): PreviewMergeRebuild {
    return new PreviewMergeRebuild(data);
  }

  get isFailed(): boolean {
    return this.current.failedAt !== null;
  }

  get failure(): string | null {
    return this.current.failure;
  }

  get failedAt(): Date | null {
    return this.current.failedAt;
  }

  /** Keeps the first reason: a rebuild that failed stays failed until a newer merge replaces it. */
  fail(reason: string, now: Date): void {
    if (this.isFailed) return;
    this.current = {
      ...this.current,
      failure: reason.slice(0, FAILURE_MAX_LENGTH),
      failedAt: now,
    };
  }

  /** The rebuild as storage holds it; only the repository's implementation reads it. */
  toData(): PreviewMergeRebuildData {
    return this.current;
  }
}
