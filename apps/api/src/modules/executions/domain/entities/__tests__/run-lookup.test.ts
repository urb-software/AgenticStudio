import { describe, expect, it } from 'vitest';
import { type RestoreData } from '../../../../../__tests__/restore-data.js';
import { RunLookup } from '../run-lookup.js';

const T0 = new Date('2026-11-17T10:00:00.000Z');
const T1 = new Date('2026-11-17T10:01:00.000Z');
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';

const REQUESTED: RestoreData<typeof RunLookup> = {
  id: 'l-1',
  runId: 'r-1',
  kind: 'pull_request_state',
  status: 'requested',
  requestedAt: T0,
  claimedBy: null,
  claimedAt: null,
  retryAt: null,
  finishedAt: null,
  error: null,
  result: null,
  scope: null,
  since: null,
};
const requested = () =>
  RunLookup.request({ id: 'l-1', runId: 'r-1', kind: 'pull_request_state', now: T0 });
const claimed = () =>
  RunLookup.restore({
    ...REQUESTED,
    status: 'claimed',
    claimedBy: WORKER,
    claimedAt: T0,
  });

describe('RunLookup', () => {
  it('is requested for a Run, open, and waits for a worker', () => {
    const lookup = requested();

    expect(lookup).toEqual(RunLookup.restore(REQUESTED));
    expect(lookup.isOpen).toBe(true);
  });

  it('carries what a review comments lookup loads', () => {
    const lookup = RunLookup.request({
      id: 'l-2',
      runId: 'r-1',
      kind: 'review_comments',
      now: T0,
      review: { scope: 'since_last_result', since: T1 },
    });

    expect(lookup).toMatchObject({ scope: 'since_last_result', since: T1 });
  });

  describe('complete', () => {
    it('stores the answer of the worker that holds it, once', () => {
      const lookup = claimed();

      expect(lookup.complete(WORKER, { state: 'open' }, T1)).toBe('stored');
      expect(lookup).toMatchObject({
        status: 'done',
        finishedAt: T1,
        result: { state: 'open' },
        error: null,
        retryAt: null,
        claimedBy: WORKER,
      });
      expect(lookup.isOpen).toBe(false);
      expect(lookup.complete(WORKER, { state: 'merged' }, T1)).toBe('duplicate');
      expect(lookup.result).toEqual({ state: 'open' });
    });

    it('is not held by another worker, nor by anybody before it is claimed: nothing changes', () => {
      const other = claimed();
      expect(other.complete(OTHER, {}, T1)).toBe('not_held');
      expect(other.status).toBe('claimed');

      const waiting = requested();
      expect(waiting.complete(WORKER, {}, T1)).toBe('not_held');
      expect(waiting.status).toBe('requested');
    });
  });

  describe('fail', () => {
    it('ends as failed with the error when there is no retry', () => {
      const lookup = claimed();

      expect(lookup.fail(WORKER, 'GitHub could not be reached.', null, T1)).toBe('stored');
      expect(lookup).toMatchObject({
        status: 'failed',
        finishedAt: T1,
        error: 'GitHub could not be reached.',
      });
      expect(lookup.fail(WORKER, 'GitHub could not be reached.', null, T1)).toBe('duplicate');
    });

    it('goes back to the queue after a rate limit, not to be handed out before its retry time', () => {
      const lookup = claimed();

      expect(lookup.fail(WORKER, 'Rate limited.', 30, T1)).toBe('stored');
      expect(lookup).toMatchObject({
        status: 'requested',
        claimedBy: null,
        claimedAt: null,
        retryAt: new Date(T1.getTime() + 30_000),
        error: 'Rate limited.',
      });
      expect(lookup.fail(WORKER, 'Rate limited.', 30, T1)).toBe('duplicate');
    });

    it('is not held by another worker: nothing changes', () => {
      const lookup = claimed();

      expect(lookup.fail(OTHER, 'x', null, T1)).toBe('not_held');
      expect(lookup.status).toBe('claimed');
      expect(requested().fail(WORKER, 'x', null, T1)).toBe('not_held');
    });
  });
});
