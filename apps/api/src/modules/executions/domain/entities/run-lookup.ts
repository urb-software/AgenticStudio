import type { RunLookupSnapshot } from './run-lookup-snapshot.js';
import type { ReviewCommentScope } from '../value-objects/review-comments.js';
import type {
  LookupAnswerOutcome,
  LookupKind,
  LookupStatus,
  RunLookupRequest,
} from '../value-objects/run-lookup.js';

/**
 * One question of Studio's for the Git host that only an agent worker can answer. Handing out
 * requests is an atomic step of the store (a claim over many lookups under a lock), not a method.
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

  get isOpen(): boolean {
    return this.status === 'requested' || this.status === 'claimed';
  }

  /** `not_held` when another worker holds it or nobody does; `duplicate` when it is done already. */
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
   * With `retryInSeconds` (a rate limit) the lookup goes back in the queue, keeping `error`
   * (already redacted). `duplicate` for a re-sent answer, `not_held` when it is not being answered.
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
