import type { PullRequestState } from '../entities/run.js';
import type {
  ClaimedLookup,
  LookupKind,
  PreparedFollowUp,
  PullRequestStateResult,
} from '../entities/run-lookup.js';

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
   * refreshed (a `failing_check_logs` request marks it as preparing instead, Issue #145, and
   * clears the last preparation's error). Serialized per Run, so two requests at once record one.
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
   * without a pull request is left alone), the error and retry time cleared. Issue #145: the
   * Pull request checks are replaced the same way (cleared for a pull request that is not open).
   */
  completePullRequestState(
    lookupId: string,
    workerId: string,
    result: PullRequestStateResult,
    now: Date,
  ): Promise<LookupAnswerOutcome>;

  /**
   * Stores a `failing_check_logs` result for a lookup `workerId` holds (Issue #145): the lookup
   * is `done`, the Run's prepared Follow-up is replaced by `draft` (one per Run) and the Run is
   * no longer preparing.
   */
  completeFailingCheckLogs(
    lookupId: string,
    workerId: string,
    draft: PreparedFollowUp,
    now: Date,
  ): Promise<LookupAnswerOutcome>;

  /**
   * Records a failed lookup `workerId` holds: the Run keeps its last known state and gets
   * `error` (already redacted); a failed `failing_check_logs` lookup sets the Run's preparation
   * error instead (Issue #145). With `retryInSeconds` (a rate limit) the lookup goes back in the
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

  /**
   * Records the state of the Run's pull request a worker read on its own (review S4 of #152: right
   * before it refused a Follow-up): the state and its read time replace the Run's, the error is
   * cleared. A merged, closed or missing pull request has no branch position, merge verdict or
   * checks worth keeping (review N1 of #152, Issue #145): those are cleared with the state (a
   * closed one keeps its branch position). A Run without a pull request is left alone.
   */
  recordObservedState(runId: string, state: PullRequestState, now: Date): Promise<void>;

  /** Removes lookups that finished (done or failed) before `before`; returns how many. */
  deleteFinishedBefore(before: Date): Promise<number>;

  /** The kind of a lookup, or `null` when there is none with this id. */
  findKind(lookupId: string): Promise<LookupKind | null>;

  /**
   * Ids of Runs with a pull request whose state is `draft`, `open` or unknown, whose last lookup
   * was requested before `attemptedBefore` (or never; a read before it counts when no attempt is
   * recorded) and that are not being refreshed, oldest attempt first (Issue #142: the daily
   * refresh; review S2 of #152: counted from the attempt, not from the last success).
   */
  listDueForDailyRefresh(attemptedBefore: Date, limit: number): Promise<string[]>;
}
