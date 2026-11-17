import type {
  ReviewCommentScope,
  ReviewCommentsRequest,
} from '../value-objects/review-comments.js';
import type { LookupAnswerOutcome, LookupKind, LookupStatus } from '../value-objects/run-lookup.js';

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

/** What requesting a lookup is made from. */
export interface RunLookupRequest {
  id: string;
  runId: string;
  kind: LookupKind;
  now: Date;
  /** Issue #146: what a `review_comments` lookup loads. */
  review?: ReviewCommentsRequest;
}

/**
 * A lookup (Issue #142): one question of Studio's for the Git host that only an agent worker can
 * answer, through the Agent account; Studio itself never reads the Git host. Its lifecycle is
 * `requested` → `claimed` (by a worker) → `done` or `failed`, with a rate-limited failure putting
 * it back to `requested` for later. It refers to its Run by id and changes nothing of the Run: what
 * an answer does to the Run, the prepared Follow-up or the Review comments is the answering
 * transaction's to do, with the lookup's outcome as its guard.
 *
 * Handing out requests is not a method here: it is one atomic step of the store, paired with
 * {@link LookupHandOutRule}, which supplies its selection (the claim is a statement over many
 * lookups under a lock, so no single lookup can decide it).
 *
 * It cannot be built in an invalid state: only {@link RunLookup.request} and
 * {@link RunLookup.restore} make one.
 */
export class RunLookup {
  declare readonly id: string;
  declare readonly runId: string;
  declare readonly kind: LookupKind;
  declare readonly status: LookupStatus;
  declare readonly requestedAt: Date;
  declare readonly claimedBy: string | null;
  declare readonly claimedAt: Date | null;
  declare readonly retryAt: Date | null;
  declare readonly finishedAt: Date | null;
  declare readonly error: string | null;
  declare readonly result: unknown;
  declare readonly scope: ReviewCommentScope | null;
  declare readonly since: Date | null;

  private constructor(data: RunLookupSnapshot) {
    Object.assign(this, data);
  }

  /** A new request, waiting for a worker. */
  static request(input: RunLookupRequest): RunLookup {
    return new RunLookup({
      id: input.id,
      runId: input.runId,
      kind: input.kind,
      status: 'requested',
      requestedAt: input.now,
      claimedBy: null,
      claimedAt: null,
      retryAt: null,
      finishedAt: null,
      error: null,
      result: null,
      scope: input.review?.scope ?? null,
      since: input.review?.since ?? null,
    });
  }

  /** A lookup as storage holds it. */
  static restore(data: RunLookupSnapshot): RunLookup {
    return new RunLookup(data);
  }

  snapshot(): RunLookupSnapshot {
    const { ...data } = this as unknown as RunLookupSnapshot;
    return data;
  }

  /** A lookup is open while it waits for a worker (`requested`) or is being answered (`claimed`). */
  get isOpen(): boolean {
    return this.status === 'requested' || this.status === 'claimed';
  }

  /**
   * The worker holding the lookup stores its answer (`result` is what the answer came to): the
   * lookup is `done`. `not_held` when another worker holds it or nobody does (nothing changes),
   * `duplicate` when it is done already (an earlier delivery of the same answer).
   */
  complete(workerId: string, result: unknown, now: Date): LookupAnswerOutcome {
    if (this.claimedBy !== workerId) return 'not_held';
    if (this.status === 'done') return 'duplicate';
    if (this.status !== 'claimed') return 'not_held';
    this.change({
      status: 'done',
      finishedAt: now,
      result,
      error: null,
      retryAt: null,
    });
    return 'stored';
  }

  /**
   * The worker holding the lookup says it failed, with `error` (already redacted). With
   * `retryInSeconds` (a rate limit) the lookup goes back in the queue, not to be handed out before
   * `now` plus that, keeping the error; otherwise it ends as `failed`. `duplicate` for a re-sent
   * answer (the lookup waits for its retry with this very error, or failed already), `not_held`
   * when another worker holds it or it is not being answered.
   */
  fail(
    workerId: string,
    error: string,
    retryInSeconds: number | null,
    now: Date,
  ): LookupAnswerOutcome {
    // A re-sent rate-limit answer (the lookup waits for its retry with this very error).
    if (this.status === 'requested' && this.retryAt !== null && this.error === error) {
      return 'duplicate';
    }
    if (this.claimedBy !== workerId) return 'not_held';
    if (this.status === 'failed') return 'duplicate';
    if (this.status !== 'claimed') return 'not_held';
    if (retryInSeconds === null) {
      this.change({ status: 'failed', finishedAt: now, error });
    } else {
      this.change({
        status: 'requested',
        claimedBy: null,
        claimedAt: null,
        retryAt: new Date(now.getTime() + retryInSeconds * 1000),
        error,
      });
    }
    return 'stored';
  }

  private change(patch: Partial<RunLookupSnapshot>): void {
    Object.assign(this, patch);
  }
}
