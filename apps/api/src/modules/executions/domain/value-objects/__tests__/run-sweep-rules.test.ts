import { describe, expect, it } from 'vitest';
import { GoneWorkerRule } from '../gone-worker-rule.js';
import { LeaseRenewalRule } from '../lease-renewal-rule.js';
import { LongWaitRule } from '../long-wait-rule.js';
import { LostWorkerRule } from '../lost-worker-rule.js';
import { OverdueStepRule } from '../overdue-step-rule.js';

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

describe('the long-wait rule', () => {
  const limits = { stepMinutes: 60, maxSteps: 5, waitingDays: 14, maxTotalSteps: 20 };
  const waiting = (days: number) => ({
    state: 'waiting_for_operator' as const,
    waitingSince: new Date(NOW.getTime() - days * 86_400_000),
    limits,
  });

  it('selects a Run that waited longer than its limit, and says so', () => {
    const rule = LongWaitRule.at(NOW);
    expect(rule.selects(waiting(15))).toBe(true);
    expect(rule.selects(waiting(14))).toBe(false);
    expect(rule.cancellationFor(waiting(15))).toMatchObject({ by: 'system' });
  });

  it('lists only Runs waiting for the operator', () => {
    expect(LongWaitRule.at(NOW).candidate({ state: 'waiting_for_operator' })).toBe(true);
    expect(LongWaitRule.at(NOW).candidate({ state: 'queued' })).toBe(false);
  });
});

describe('the gone-worker rule', () => {
  it('calls a requested, unheld delivery retry pending', () => {
    const retry = { state: 'failed' as const, deliveryRequested: true, claimedBy: null };
    expect(GoneWorkerRule.at(NOW, 60).pendingDeliveryRetry(retry)).toBe(true);
    expect(GoneWorkerRule.at(NOW, 60).pendingDeliveryRetry({ ...retry, claimedBy: 'w' })).toBe(
      false,
    );
    expect(
      GoneWorkerRule.at(NOW, 60).pendingDeliveryRetry({ ...retry, deliveryRequested: false }),
    ).toBe(false);
  });

  it('calls a queued Run with an agent session a pending resume', () => {
    expect(GoneWorkerRule.at(NOW, 60).pendingResume({ state: 'queued', sessionRef: 's' })).toBe(
      true,
    );
    expect(GoneWorkerRule.at(NOW, 60).pendingResume({ state: 'queued', sessionRef: null })).toBe(
      false,
    );
    expect(GoneWorkerRule.at(NOW, 60).pendingResume({ state: 'failed', sessionRef: 's' })).toBe(
      false,
    );
  });
});

describe('the lease renewal rule', () => {
  const rule = LeaseRenewalRule.at(NOW, 60);

  it('renews the Runs a worker holds while preparing or running', () => {
    expect(rule.renews({ state: 'preparing' })).toBe(true);
    expect(rule.renews({ state: 'running' })).toBe(true);
    expect(rule.renews({ state: 'failed' })).toBe(false);
    expect(rule.renews({ state: 'waiting_for_operator' })).toBe(false);
  });

  it('is due when there was no renewal or the last is a lease old', () => {
    expect(rule.isDue(null)).toBe(true);
    expect(rule.isDue(ago(60))).toBe(true);
    expect(rule.isDue(ago(59))).toBe(false);
  });
});
