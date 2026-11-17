import { describe, expect, it } from 'vitest';
import { RunProgress } from '../run-progress.js';

// Issue #100, #141: the Run steps taken and what the limits allow. No database.
const NOW = new Date('2026-11-16T12:00:00.000Z');
const LIMITS = { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 };
const started = () => RunProgress.start(LIMITS, NOW);

describe('RunProgress', () => {
  it('starts with no step taken, no Follow-up and the limits it was given (copied)', () => {
    const progress = started();
    expect(progress.toStored()).toEqual({
      stepCount: 0,
      stepsBeforePart: 0,
      followUpCount: 0,
      followUpQueued: false,
      stepStartedAt: null,
      waitingSince: null,
      lastActivityAt: NOW,
      limits: LIMITS,
    });
    expect(progress.limits).not.toBe(LIMITS);
  });

  it('returns new progress for a change and leaves the old one as it was', () => {
    const before = started();
    const after = before.with({ stepCount: 3, stepStartedAt: NOW });

    expect(after).not.toBe(before);
    expect(before.stepCount).toBe(0);
    expect(before.stepStartedAt).toBeNull();
    expect(after.stepCount).toBe(3);
    expect(after.stepStartedAt).toEqual(NOW);
    expect(after.limits).toEqual(LIMITS);
  });

  it('allows the steps of the current part: the first, or a Follow-up, up to maxSteps', () => {
    const first = started();
    expect(first.allowsStep(10)).toBe(true);
    expect(first.allowsStep(11)).toBe(false);
    // A Follow-up gets its own allowance from the steps taken before it (Issue #141).
    const followUp = first.with({ stepCount: 10, stepsBeforePart: 10, followUpCount: 1 });
    expect(followUp.allowsStep(20)).toBe(true);
    expect(followUp.allowsStep(21)).toBe(false);
  });

  it('reaches the step total, after which it accepts no Follow-up', () => {
    expect(started().with({ stepCount: 49 }).reachedStepTotal).toBe(false);
    expect(started().with({ stepCount: 50 }).reachedStepTotal).toBe(true);
  });

  it('says which limit was reached and that no further step was started (Issue #100)', () => {
    expect(started().stepLimitFailure()).toEqual({
      code: 'step_limit',
      detail: 'The run reached its limit of 10 run steps; no further step was started.',
    });
  });

  it('says a Follow-up reached its own limit (Issue #141)', () => {
    expect(started().with({ followUpCount: 1 }).stepLimitFailure()).toEqual({
      code: 'step_limit',
      detail: 'The Follow-up reached its limit of 10 run steps; no further step was started.',
    });
    expect(started().with({ followUpCount: 1 }).inFollowUp).toBe(true);
    expect(started().inFollowUp).toBe(false);
  });

  it('writes the singular for one step', () => {
    const one = RunProgress.start({ ...LIMITS, maxSteps: 1 }, NOW);
    expect(one.stepLimitFailure().detail).toContain('1 run step;');
  });
});
