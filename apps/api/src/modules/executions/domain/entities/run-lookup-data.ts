import type { ReviewCommentScope } from '../value-objects/review-comment-scope.js';
import type { LookupKind } from '../value-objects/lookup-kind.js';
import type { LookupStatus } from '../value-objects/lookup-status.js';

/** A lookup's current values. */
export interface RunLookupData {
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
  readonly scope: ReviewCommentScope | null;
  readonly since: Date | null;
}
