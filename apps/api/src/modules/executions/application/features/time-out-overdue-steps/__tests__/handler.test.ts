import { describe, expect, it } from 'vitest';
import { OverdueStepRule } from '../../../../domain/value-objects/overdue-step-rule.js';
import type { RunRepository } from '../../../../domain/repositories/run-repository.js';
import { TimeOutOverdueStepsHandler } from '../handler.js';

const NOW = new Date('2026-11-17T12:00:00.000Z');

describe('TimeOutOverdueStepsHandler', () => {
  it('asks the store to time out overdue steps at the clock time with the grace period', async () => {
    const calls: [Date, number][] = [];
    const runs = {
      timeOutOverdueSteps: (now: Date, grace: number) => {
        calls.push([now, grace]);
        return Promise.resolve(2);
      },
    } as unknown as RunRepository;

    const { timedOut } = await new TimeOutOverdueStepsHandler(runs, { now: () => NOW }).execute();

    expect(timedOut).toBe(2);
    expect(calls).toEqual([[NOW, OverdueStepRule.GRACE_MINUTES]]);
  });
});
