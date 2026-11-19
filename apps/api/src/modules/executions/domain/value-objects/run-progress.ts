import { RunFailure } from './run-failure.js';
import type { RunLimits } from './run-limits.js';

export interface RunProgressData {
  stepCount: number;
  stepsBeforePart: number;
  followUpCount: number;
  followUpQueued: boolean;
  /** Cleared when the step's result is reported: Studio's time-limit backstop then stops. */
  stepStartedAt: Date | null;
  waitingSince: Date | null;
  /** Working copy retention counts a Run with a pull request idle from here. */
  lastActivityAt: Date;
  limits: RunLimits;
}

export class RunProgress {
  readonly stepCount: number;
  readonly stepsBeforePart: number;
  readonly followUpCount: number;
  readonly followUpQueued: boolean;
  readonly stepStartedAt: Date | null;
  readonly waitingSince: Date | null;
  readonly lastActivityAt: Date;
  readonly limits: RunLimits;

  private constructor(stored: RunProgressData) {
    this.stepCount = stored.stepCount;
    this.stepsBeforePart = stored.stepsBeforePart;
    this.followUpCount = stored.followUpCount;
    this.followUpQueued = stored.followUpQueued;
    this.stepStartedAt = stored.stepStartedAt;
    this.waitingSince = stored.waitingSince;
    this.lastActivityAt = stored.lastActivityAt;
    this.limits = stored.limits;
  }

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

  static restore(stored: RunProgressData): RunProgress {
    return new RunProgress(stored);
  }

  with(patch: Partial<RunProgressData>): RunProgress {
    return new RunProgress({ ...this.toData(), ...patch });
  }

  toData(): RunProgressData {
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

  get inFollowUp(): boolean {
    return this.followUpCount > 0;
  }

  get reachedStepTotal(): boolean {
    return this.stepCount >= this.limits.maxTotalSteps;
  }

  allowsStep(index: number): boolean {
    return index <= this.stepsBeforePart + this.limits.maxSteps;
  }

  stepLimitFailure(): RunFailure {
    const { maxSteps } = this.limits;
    const steps = `${maxSteps} run ${maxSteps === 1 ? 'step' : 'steps'}`;
    return RunFailure.of(
      'step_limit',
      this.inFollowUp
        ? `The Follow-up reached its limit of ${steps}; no further step was started.`
        : `The run reached its limit of ${steps}; no further step was started.`,
    );
  }
}
