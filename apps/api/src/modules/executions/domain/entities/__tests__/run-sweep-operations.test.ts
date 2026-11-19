import { describe, expect, it } from 'vitest';
import { Run } from '../run.js';
import type { RestoreData } from '../../../../../__tests__/restore-data.js';
import { AT, runData } from './run-fixtures.js';

const LATER = new Date('2026-11-20T12:00:00.000Z');
const FAILURE = { code: 'delivery_failed', detail: 'gone' } as const;
const restored = (patch: Partial<RestoreData<typeof Run>>) => Run.restore(runData(patch));

describe('Run.cancelAfterWaiting', () => {
  const cancellation = { by: 'system', reason: 'too long' } as const;

  it('cancels a waiting Run and leaves its activity time alone', () => {
    const run = restored({});

    expect(run.cancelAfterWaiting(cancellation, LATER)).toBe(true);

    expect(run.lifecycle).toMatchObject({ state: 'cancelled', finishedAt: LATER, cancellation });
    expect(run.progress.waitingSince).toBeNull();
    expect(run.pendingChanges().fields).toEqual({
      state: 'cancelled',
      cancellation,
      waitingSince: null,
      finishedAt: LATER,
      followUpQueued: false,
    });
  });

  it.each(['queued', 'running', 'succeeded', 'cancelled'] as const)(
    'changes nothing for a Run that is %s',
    (state) => {
      const run = restored({
        state,
        waitingSince: null,
        ...(state === 'cancelled' ? { cancellation } : {}),
      });

      expect(run.cancelAfterWaiting(cancellation, LATER)).toBe(false);
      expect(run.pendingChanges().fields).toEqual({});
    },
  );
});

describe('Run.abandonDeliveryRetry', () => {
  const earlier = { code: 'delivery_failed', detail: 'push refused' } as const;
  const pending = {
    state: 'failed',
    failure: earlier,
    deliveryRequested: true,
    waitingSince: null,
  } as const;

  it('fails the pending retry of a Run no worker holds', () => {
    const run = restored(pending);

    expect(run.abandonDeliveryRetry(FAILURE, LATER)).toBe(true);

    expect(run.pendingChanges().fields).toEqual({
      failure: FAILURE,
      delivery: 'failed',
      deliveryRequested: false,
      finishedAt: LATER,
    });
  });

  it.each([
    ['no retry requested', { ...pending, deliveryRequested: false }],
    ['a worker holds it', { ...pending, claimedBy: 'worker-1', heartbeatAt: AT }],
    ['not failed', { ...pending, state: 'queued' as const, failure: null }],
  ])('changes nothing when %s', (_name, patch) => {
    const run = restored(patch);

    expect(run.abandonDeliveryRetry(FAILURE, LATER)).toBe(false);
    expect(run.pendingChanges().fields).toEqual({});
  });
});

describe('Run.abandonResume', () => {
  const resumable = { state: 'queued', waitingSince: null, followUpQueued: true } as const;
  const failure = { code: 'preparation_failed', detail: 'gone' } as const;

  it('fails a queued Run that holds a session reference', () => {
    const run = restored(resumable);

    expect(run.abandonResume(failure, LATER)).toBe(true);

    expect(run.lifecycle).toMatchObject({ state: 'failed', finishedAt: LATER });
    expect(run.pendingChanges().fields).toEqual({
      state: 'failed',
      failure,
      finishedAt: LATER,
      followUpQueued: false,
    });
  });

  it.each([
    ['it has no session reference', { ...resumable, sessionRef: null }],
    ['it is not queued', { ...resumable, state: 'failed' as const, failure }],
  ])('changes nothing when %s', (_name, patch) => {
    const run = restored(patch);

    expect(run.abandonResume(failure, LATER)).toBe(false);
    expect(run.pendingChanges().fields).toEqual({});
  });
});
