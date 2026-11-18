import type { RunPartEnd } from './run-conversation.js';
import type { RunDeliveryState } from './run-delivery.js';
import { OPERATOR_CANCELLATION_PREFIX, type RunCancellation } from './run-cancellation.js';
import { IllegalRunTransitionError } from '../errors/run-errors.js';
import type { RunFailure } from './run-failure.js';
import { isFinalRunState, isRunState, type RunState } from './run-state.js';

/** What a Run's lifecycle stores of it. */
export interface RunLifecycleStored {
  state: RunState;
  /** When an agent worker claimed it. */
  startedAt: Date | null;
  /** When it reached a final state. */
  finishedAt: Date | null;
  /** Set exactly when `failed`. */
  failure: RunFailure | null;
  /** Set exactly when `cancelled`. */
  cancellation: RunCancellation | null;
  /**
   * When the operator asked to cancel a `preparing` or `running` Run (Issue #100); the Run
   * stays in its state until the agent worker confirms the stop.
   */
  cancelRequestedAt: Date | null;
}

/**
 * The lifecycle of a Run: its state with the transitions each state allows, and how it ended (the
 * failure or the cancellation) with the times it started, finished and was asked to stop. The
 * `Run` class asks it before every transition and sets the target state in its own methods, so
 * which state allows which transition lives here and nowhere else:
 *
 * - `queued` → `preparing` (claimed) or cancelled / timed out;
 * - `preparing` → `running`, or failed / cancelled / timed out;
 * - `running` → `waiting_for_operator` (a question), `succeeded`, or failed / cancelled / timed out;
 * - `waiting_for_operator` → `queued` (the operator answered), or cancelled / timed out;
 * - the final states `succeeded`, `failed`, `cancelled` and `timed_out` allow none; the operator's
 *   Follow-up, a delivery retry and a usage-limit resume are the ways out of a final state, and
 *   the Run applies them itself.
 *
 * A change returns a new lifecycle.
 */
export class RunLifecycle {
  private static readonly TRANSITIONS: Record<RunState, readonly RunState[]> = {
    queued: ['preparing', 'cancelled', 'timed_out'],
    preparing: ['running', 'failed', 'cancelled', 'timed_out'],
    running: ['waiting_for_operator', 'succeeded', 'failed', 'cancelled', 'timed_out'],
    // Issue #103: the operator's answer queues the Run again; a worker claims it to resume.
    waiting_for_operator: ['queued', 'cancelled', 'timed_out'],
    succeeded: [],
    failed: [],
    cancelled: [],
    timed_out: [],
  };

  readonly state: RunState;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly failure: RunFailure | null;
  readonly cancellation: RunCancellation | null;
  readonly cancelRequestedAt: Date | null;

  private constructor(stored: RunLifecycleStored) {
    this.state = stored.state;
    this.startedAt = stored.startedAt;
    this.finishedAt = stored.finishedAt;
    this.failure = stored.failure;
    this.cancellation = stored.cancellation;
    this.cancelRequestedAt = stored.cancelRequestedAt;
  }

  /** The lifecycle of a Run just started: `queued`, nothing happened yet. */
  static start(): RunLifecycle {
    return new RunLifecycle({
      state: 'queued',
      startedAt: null,
      finishedAt: null,
      failure: null,
      cancellation: null,
      cancelRequestedAt: null,
    });
  }

  /** A lifecycle as storage holds it. Throws {@link TypeError} for state the store should never hold. */
  static restore(stored: RunLifecycleStored): RunLifecycle {
    if (!isRunState(stored.state)) throw new TypeError(`Unknown run state: ${stored.state}`);
    if ((stored.state === 'failed') !== (stored.failure !== null)) {
      throw new TypeError('A Run has a failure exactly when it is failed.');
    }
    if ((stored.state === 'cancelled') !== (stored.cancellation !== null)) {
      throw new TypeError('A Run has a cancellation exactly when it is cancelled.');
    }
    return new RunLifecycle(stored);
  }

  /** The lifecycle with the stored fields in `patch` replaced (other keys are ignored). */
  with(patch: Partial<RunLifecycleStored>): RunLifecycle {
    return new RunLifecycle({ ...this.toStored(), ...patch });
  }

  toStored(): RunLifecycleStored {
    return {
      state: this.state,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      failure: this.failure,
      cancellation: this.cancellation,
      cancelRequestedAt: this.cancelRequestedAt,
    };
  }

  /** Whether a Run may go from state `from` to state `to`. */
  static canTransition(from: RunState, to: RunState): boolean {
    return RunLifecycle.TRANSITIONS[from].includes(to);
  }

  /** Throws {@link IllegalRunTransitionError} unless `from` → `to` is allowed. */
  static assertTransition(from: RunState, to: RunState): void {
    if (!RunLifecycle.canTransition(from, to)) throw new IllegalRunTransitionError(from, to);
  }

  /** Throws {@link IllegalRunTransitionError} unless the Run may go from its state to `to`. */
  assertTransitionTo(to: RunState): void {
    RunLifecycle.assertTransition(this.state, to);
  }

  /** Whether the Run is over: terminal, only a delivery retry, a resume or a Follow-up reopens it. */
  get isFinal(): boolean {
    return isFinalRunState(this.state);
  }

  /** Whether the operator asked to cancel and the worker has not confirmed the stop yet. */
  get cancelRequested(): boolean {
    return this.cancelRequestedAt !== null;
  }

  private get failureCode(): string | null {
    return this.state === 'failed' ? (this.failure?.code ?? null) : null;
  }

  /**
   * Whether the operator may retry the Run's delivery (Issue #102): only a `failed` Run whose
   * failure is `delivery_failed`. Its outcome is the one exception to the final states: on
   * success the Run becomes `succeeded`, otherwise it stays `failed` with the new reason.
   */
  get canRetryDelivery(): boolean {
    return this.failureCode === 'delivery_failed';
  }

  /** Whether the Run stopped at the subscription's usage limit (Issue #105): `failed` with `usage_limit`. */
  get stoppedAtUsageLimit(): boolean {
    return this.failureCode === 'usage_limit';
  }

  /**
   * Whether a final Run keeps its Environment file snapshot because it can still go on: `failed`
   * with `delivery_failed`, whose delivery can be retried (Issue #102), or with `usage_limit`,
   * which the operator can resume (Issue #105). Kept until the Run ends otherwise, its retry or
   * resume is given up (Working copy or worker gone), or the retention period ends.
   */
  get keepsEnvironmentFileForRetry(): boolean {
    return this.canRetryDelivery || this.stoppedAtUsageLimit;
  }

  /**
   * How the Run's current part ended, as recorded in its conversation when a Follow-up reopens
   * it (review S1 of #150); `null` while it is not final. `delivery` is the Run's delivery state,
   * a fact of another concept.
   */
  partEnd(delivery: RunDeliveryState | null): RunPartEnd | null {
    if (!isFinalRunState(this.state)) return null;
    return {
      state: this.state,
      failureCode: this.failure?.code ?? null,
      delivery,
      detail: this.failure?.detail ?? this.cancellation?.reason ?? '',
    };
  }

  /**
   * The result a Run had before a part that changed nothing (Issue #147): the state, failure and
   * cancellation its `part_end` recorded, which the Follow-up cleared. The cancel's author is told
   * from its reason, which only the cancellation's wording fixes.
   */
  static earlierResult(
    end: RunPartEnd,
  ): Pick<RunLifecycleStored, 'state' | 'failure' | 'cancellation'> {
    return {
      state: end.state,
      failure:
        end.state === 'failed' && end.failureCode
          ? { code: end.failureCode, detail: end.detail }
          : null,
      cancellation:
        end.state === 'cancelled'
          ? {
              by: end.detail.startsWith(OPERATOR_CANCELLATION_PREFIX) ? 'operator' : 'system',
              reason: end.detail,
            }
          : null,
    };
  }
}
