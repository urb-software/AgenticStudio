import type { RunFailure } from './run-failure.js';
import type { RunLimits } from './run-limits.js';

/** What a Run's progress stores of it. */
export interface RunProgressStored {
  /** How many Run steps the Run has taken (stored step results; Issue #141). */
  stepCount: number;
  /** How many Run steps the Run had taken when its current part began (Issue #141). */
  stepsBeforePart: number;
  /** How many Follow-ups the operator sent (Issue #141). */
  followUpCount: number;
  /** Queued for a Follow-up its agent worker has not claimed yet (Issue #141). */
  followUpQueued: boolean;
  /**
   * When the current Run step started: set whenever the Run goes to `running`, cleared when the
   * step's result is reported (Studio's time-limit backstop then stops: review of #121).
   */
  stepStartedAt: Date | null;
  /** When it began waiting for the operator; set exactly when `waiting_for_operator`. */
  waitingSince: Date | null;
  /**
   * The latest Run step, Answer or Follow-up, or the Run's creation (Issue #143): Working copy
   * retention counts a Run with a pull request idle from here.
   */
  lastActivityAt: Date;
  /** The limits in force for this Run (Issue #100). */
  limits: RunLimits;
}

/**
 * How far a Run has come and what it may still do (Issues #100, #141): the Run steps taken, in
 * total and before the current part, the Follow-ups sent, when the current step started and the
 * Run began waiting, its latest activity, and the limits it was started with. A change returns
 * new progress.
 */
export class RunProgress {
  readonly stepCount: number;
  readonly stepsBeforePart: number;
  readonly followUpCount: number;
  readonly followUpQueued: boolean;
  readonly stepStartedAt: Date | null;
  readonly waitingSince: Date | null;
  readonly lastActivityAt: Date;
  readonly limits: RunLimits;

  private constructor(stored: RunProgressStored) {
    this.stepCount = stored.stepCount;
    this.stepsBeforePart = stored.stepsBeforePart;
    this.followUpCount = stored.followUpCount;
    this.followUpQueued = stored.followUpQueued;
    this.stepStartedAt = stored.stepStartedAt;
    this.waitingSince = stored.waitingSince;
    this.lastActivityAt = stored.lastActivityAt;
    this.limits = stored.limits;
  }

  /** The progress of a Run just started at `now`, with the `limits` in force. */
  static start(limits: RunLimits, now: Date): RunProgress {
    return new RunProgress({
      stepCount: 0,
      stepsBeforePart: 0,
      followUpCount: 0,
      followUpQueued: false,
      stepStartedAt: null,
      waitingSince: null,
      lastActivityAt: now,
      limits: { ...limits },
    });
  }

  static restore(stored: RunProgressStored): RunProgress {
    return new RunProgress(stored);
  }

  /** The progress with the stored fields in `patch` replaced (other keys are ignored). */
  with(patch: Partial<RunProgressStored>): RunProgress {
    return new RunProgress({ ...this.toStored(), ...patch });
  }

  toStored(): RunProgressStored {
    return {
      stepCount: this.stepCount,
      stepsBeforePart: this.stepsBeforePart,
      followUpCount: this.followUpCount,
      followUpQueued: this.followUpQueued,
      stepStartedAt: this.stepStartedAt,
      waitingSince: this.waitingSince,
      lastActivityAt: this.lastActivityAt,
      limits: this.limits,
    };
  }

  /** Whether the Run works on a Follow-up rather than on its first part. */
  get inFollowUp(): boolean {
    return this.followUpCount > 0;
  }

  /** Whether the Run reached its Run step total, so it accepts no Follow-up (Issue #141). */
  get reachedStepTotal(): boolean {
    return this.stepCount >= this.limits.maxTotalSteps;
  }

  /**
   * Whether the Run step numbered `index` is within the allowance of the current part: the first
   * part, and each Follow-up, may take `maxSteps` steps (Issue #141).
   */
  allowsStep(index: number): boolean {
    return index <= this.stepsBeforePart + this.limits.maxSteps;
  }

  /**
   * The failure of a Run that would exceed its maximum number of Run steps (Issue #100); in a
   * Follow-up the allowance is the Follow-up's own (Issue #141).
   */
  stepLimitFailure(): RunFailure {
    const { maxSteps } = this.limits;
    const steps = `${maxSteps} run ${maxSteps === 1 ? 'step' : 'steps'}`;
    return {
      code: 'step_limit',
      detail: this.inFollowUp
        ? `The Follow-up reached its limit of ${steps}; no further step was started.`
        : `The run reached its limit of ${steps}; no further step was started.`,
    };
  }
}
