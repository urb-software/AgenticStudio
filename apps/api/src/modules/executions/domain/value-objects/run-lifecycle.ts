import type { RunPartEnd } from './run-conversation.js';
import type { RunDeliveryState } from './run-delivery.js';
import { OPERATOR_CANCELLATION_PREFIX, type RunCancellation } from './run-cancellation.js';
import { IllegalRunTransitionError } from '../errors/run-errors.js';
import type { RunFailure } from './run-failure.js';
import { isFinalRunState, isRunState, type RunState } from './run-state.js';

export interface RunLifecycleStored {
  state: RunState;
  startedAt: Date | null;
  finishedAt: Date | null;
  failure: RunFailure | null;
  cancellation: RunCancellation | null;
  /** The Run stays in its state until the agent worker confirms the stop. */
  cancelRequestedAt: Date | null;
}

/**
 * The operator's Follow-up, a delivery retry and a usage-limit resume are the ways out of a final
 * state; the Run applies them itself.
 */
export class RunLifecycle {
  private static readonly TRANSITIONS: Record<RunState, readonly RunState[]> = {
    queued: ['preparing', 'cancelled', 'timed_out'],
    preparing: ['running', 'failed', 'cancelled', 'timed_out'],
    running: ['waiting_for_operator', 'succeeded', 'failed', 'cancelled', 'timed_out'],
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

  /** Throws {@link TypeError} for state the store should never hold. */
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

  static canTransition(from: RunState, to: RunState): boolean {
    return RunLifecycle.TRANSITIONS[from].includes(to);
  }

  static assertTransition(from: RunState, to: RunState): void {
    if (!RunLifecycle.canTransition(from, to)) throw new IllegalRunTransitionError(from, to);
  }

  assertTransitionTo(to: RunState): void {
    RunLifecycle.assertTransition(this.state, to);
  }

  get isFinal(): boolean {
    return isFinalRunState(this.state);
  }

  get cancelRequested(): boolean {
    return this.cancelRequestedAt !== null;
  }

  private get failureCode(): string | null {
    return this.state === 'failed' ? (this.failure?.code ?? null) : null;
  }

  /**
   * Its outcome is the one exception to the final states: on success the Run becomes `succeeded`,
   * otherwise it stays `failed` with the new reason.
   */
  get canRetryDelivery(): boolean {
    return this.failureCode === 'delivery_failed';
  }

  get stoppedAtUsageLimit(): boolean {
    return this.failureCode === 'usage_limit';
  }

  /**
   * Kept until the Run ends otherwise, its retry or resume is given up (Working copy or worker
   * gone), or the retention period ends.
   */
  get keepsEnvironmentFileForRetry(): boolean {
    return this.canRetryDelivery || this.stoppedAtUsageLimit;
  }

  partEnd(delivery: RunDeliveryState | null): RunPartEnd | null {
    if (!isFinalRunState(this.state)) return null;
    return {
      state: this.state,
      failureCode: this.failure?.code ?? null,
      delivery,
      detail: this.failure?.detail ?? this.cancellation?.reason ?? '',
    };
  }

  /** The cancel's author is told from its reason, which only the cancellation's wording fixes. */
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
