import type { ClaimedLookup, LookupKind, PullRequestStateResult } from '../entities/run-lookup.js';

/** DI token for the {@link RunLookupRepository} adapter. */
export const RUN_LOOKUP_REPOSITORY = Symbol('RUN_LOOKUP_REPOSITORY');

/** What requesting a lookup did. */
export type LookupRequestOutcome =
  /** A new request was recorded. */
  | 'requested'
  /** A request for this Run and kind is open already (waiting, or being answered). */
  | 'open'
  /** The Run has no pull request (or no known Run branch) to look up. */
  | 'not_possible';

/** What a worker's answer did. */
export type LookupAnswerOutcome =
  /** Stored now. */
  | 'stored'
  /** Already stored by an earlier delivery of the same answer. */
  | 'duplicate'
  /** The lookup is not (any more) claimed by this worker; nothing changed. */
  | 'not_held';

/**
 * The store of lookups (Issue #142): requests Studio records for the agent worker, and the
 * answers that update what Studio knows. At most one open request per Run and kind. A request
 * is open while it is `requested` or `claimed`; a claim older than the lease is handed out
 * again.
 */
export interface RunLookupRepository {
  /**
   * Records a request of `kind` for the Run unless one is open, and marks the Run as being
   * refreshed. Serialized per Run, so two requests at once record one.
   */
  request(runId: string, kind: LookupKind, now: Date): Promise<LookupRequestOutcome>;

  /**
   * Hands up to `limit` waiting requests (not those a rate limit asks to wait for) to
   * `workerId`, oldest first; a claim that is older than the lease is first returned to the
   * queue. Any worker may claim: a lookup needs no Working copy.
   */
  claim(workerId: string, now: Date, limit: number, leaseSeconds: number): Promise<ClaimedLookup[]>;

  /**
   * Stores a `pull_request_state` result for a lookup `workerId` holds: the lookup is `done`
   * and the Run's pull request state, branch position and refresh time are replaced (a Run
   * without a pull request is left alone), the error and retry time cleared.
   */
  completePullRequestState(
    lookupId: string,
    workerId: string,
    result: PullRequestStateResult,
    now: Date,
  ): Promise<LookupAnswerOutcome>;

  /**
   * Records a failed lookup `workerId` holds: the Run keeps its last known state and gets
   * `error` (already redacted). With `retryInSeconds` (a rate limit) the lookup goes back in the
   * queue, not to be handed out before `now` plus that, and the Run says when; otherwise the
   * lookup ends as `failed`.
   */
  fail(
    lookupId: string,
    workerId: string,
    error: string,
    retryInSeconds: number | null,
    now: Date,
  ): Promise<LookupAnswerOutcome>;

  /** The kind of a lookup, or `null` when there is none with this id. */
  findKind(lookupId: string): Promise<LookupKind | null>;

  /**
   * Ids of Runs with a pull request whose state is `draft`, `open` or unknown, last read before
   * `refreshedBefore` (or never) and not being refreshed, oldest read first (Issue #142: the
   * daily refresh).
   */
  listDueForDailyRefresh(refreshedBefore: Date, limit: number): Promise<string[]>;
}
