import { describe, expect, it } from 'vitest';
import { LostWorkerRule, OverdueStepRule } from '../run-sweep-rules.js';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

describe('the lost-worker rule', () => {
  const rule = LostWorkerRule.at(NOW, 60);

  it('selects a held Run whose heartbeat is older than the lease', () => {
    expect(rule.selects({ claimedBy: 'w', heartbeatAt: ago(61) })).toBe(true);
    expect(rule.selects({ claimedBy: 'w', heartbeatAt: ago(60) })).toBe(false);
    expect(rule.selects({ claimedBy: 'w', heartbeatAt: ago(5) })).toBe(false);
  });

  it('selects no Run nobody holds', () => {
    expect(rule.selects({ claimedBy: null, heartbeatAt: null })).toBe(false);
  });

  it('fails an active Run and keeps a failed delivery retry a failed delivery', () => {
    expect(rule.resultFor({ state: 'running' })).toEqual({
      failure: rule.failure,
      retryEnds: false,
    });
    expect(rule.failure.code).toBe('worker_lost');
    expect(rule.resultFor({ state: 'failed' })).toEqual({
      failure: rule.deliveryFailure,
      retryEnds: true,
    });
    expect(rule.deliveryFailure.code).toBe('delivery_failed');
  });
});

describe('the overdue-step rule', () => {
  const rule = OverdueStepRule.at(NOW, 5);
  const limits = { stepMinutes: 60, maxSteps: 5, waitingDays: 14, maxTotalSteps: 20 };

  it('selects a running Run whose step ran past its limit and the grace', () => {
    const run = (minutes: number) => ({
      state: 'running' as const,
      stepStartedAt: ago(minutes * 60),
      limits,
    });
    expect(rule.selects(run(66))).toBe(true);
    expect(rule.selects(run(65))).toBe(false);
    expect(rule.selects(run(10))).toBe(false);
  });

  it('selects nothing once the step is reported, or for a Run that is not running', () => {
    expect(rule.selects({ state: 'running', stepStartedAt: null, limits })).toBe(false);
    expect(rule.selects({ state: 'preparing', stepStartedAt: ago(9999), limits })).toBe(false);
  });
});
