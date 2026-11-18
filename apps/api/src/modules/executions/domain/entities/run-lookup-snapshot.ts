import type { ReviewCommentScope } from '../value-objects/review-comments.js';
import type { LookupKind, LookupStatus } from '../value-objects/run-lookup.js';

/** A lookup's current values as read-only plain data (rule 10); {@link RunLookup.snapshot}. */
export interface RunLookupSnapshot {
  readonly id: string;
  /** The Run it is about, by id. */
  readonly runId: string;
  readonly kind: LookupKind;
  readonly status: LookupStatus;
  readonly requestedAt: Date;
  /** The agent worker that holds it: set exactly while `claimed`, and kept when it is answered. */
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  /** A rate-limited lookup is not handed out before this time. */
  readonly retryAt: Date | null;
  readonly finishedAt: Date | null;
  /** The worker's words when it failed (redacted); also kept while a rate-limited one waits. */
  readonly error: string | null;
  /** What the worker's answer came to, for the record (the data itself is kept elsewhere). */
  readonly result: unknown;
  /** Issue #146: what a `review_comments` lookup loads. */
  readonly scope: ReviewCommentScope | null;
  readonly since: Date | null;
}
