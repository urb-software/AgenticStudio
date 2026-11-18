import { describe, expect, it } from 'vitest';
import { type HandOutView } from '../hand-out-view.js';
import { HandOutRule } from '../hand-out-rule.js';

const W1 = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const W2 = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

let sequence = 0;
function run(id: string, project: string, overrides: Partial<HandOutView> = {}): HandOutView {
  return {
    id,
    projectId: project,
    state: 'queued',
    claimedBy: null,
    sessionRef: null,
    followUpQueued: false,
    deliveryRequested: false,
    lastClaimedBy: null,
    createdAt: new Date(Date.UTC(2026, 10, 15, 10, 0, sequence++)),
    ...overrides,
  };
}

const running = (id: string, project: string) =>
  run(id, project, { state: 'running', claimedBy: W1, lastClaimedBy: W1 });
const answered = (id: string, project: string, worker = W1) =>
  run(id, project, { sessionRef: 'session-1', lastClaimedBy: worker });
const retrying = (id: string, project: string, overrides: Partial<HandOutView> = {}) =>
  run(id, project, { state: 'failed', deliveryRequested: true, lastClaimedBy: W1, ...overrides });

const ids = (runs: readonly HandOutView[], worker = W1) => {
  const rule = HandOutRule.for(worker);
  const handed: string[] = [];
  const left = [...runs];
  for (let next = rule.next(left); next; next = rule.next(left)) {
    handed.push(next.id);
    const index = left.findIndex((candidate) => candidate.id === next.id);
    left[index] = { ...next, state: 'running', claimedBy: worker };
  }
  return handed;
};

describe('the hand-out rule', () => {
  it('hands out the oldest queued Run first, ties by id', () => {
    const same = new Date(Date.UTC(2026, 10, 15, 9, 0, 0));
    const queue = [
      run('c', 'p3', { createdAt: same }),
      run('a', 'p1', { createdAt: same }),
      run('b', 'p2', { createdAt: new Date(Date.UTC(2026, 10, 15, 8, 0, 0)) }),
    ];

    expect(HandOutRule.for(W1).next(queue)?.id).toBe('b');
    expect(HandOutRule.for(W1).next(queue.filter((candidate) => candidate.id !== 'b'))?.id).toBe(
      'a',
    );
  });

  it('hands out one Run per project: a second waits while one holds the place', () => {
    const queue = [running('r1', 'p1'), run('q1', 'p1'), run('q2', 'p2')];

    expect(HandOutRule.for(W1).next(queue)?.id).toBe('q2');
    expect(HandOutRule.for(W1).next([running('r1', 'p1'), run('q1', 'p1')])).toBeUndefined();
  });

  it('hands out at most the server-wide limit, whatever the projects', () => {
    const queue = [run('a', 'p1'), run('b', 'p2'), run('c', 'p3'), run('d', 'p4')];

    expect(ids(queue)).toEqual(['a', 'b']);
    expect(HandOutRule.MAX_PLACES).toBe(2);
  });

  it('counts a Run waiting for the operator as holding its place', () => {
    const waiting = run('w', 'p1', { state: 'waiting_for_operator', lastClaimedBy: W1 });

    expect(HandOutRule.for(W1).next([waiting, run('q', 'p1')])).toBeUndefined();
    expect(HandOutRule.for(W1).next([waiting, run('q', 'p2')])?.id).toBe('q');
  });

  describe('which worker may take a Run', () => {
    it('lets any worker start a Run nobody started', () => {
      expect(HandOutRule.for(W2).next([run('q', 'p1')])?.id).toBe('q');
    });

    it('lets only the worker that started an answered Run resume it', () => {
      const queue = [answered('a', 'p1', W1)];

      expect(HandOutRule.for(W1).next(queue)?.id).toBe('a');
      expect(HandOutRule.for(W2).next(queue)).toBeUndefined();
    });

    it('lets an answered Run keep its place while it waits, and hands it out despite it', () => {
      const queue = [answered('a', 'p1'), run('q', 'p1')];

      expect(HandOutRule.for(W1).next(queue)?.id).toBe('a');
      expect(HandOutRule.for(W2).next(queue)).toBeUndefined();
    });

    it('lets a Run queued for a Follow-up hold no place until it is claimed', () => {
      const followUp = answered('f', 'p1', W1);
      const queue = [{ ...followUp, followUpQueued: true }, run('q', 'p1')];

      expect(HandOutRule.for(W2).next(queue)?.id).toBe('q');
      expect(ids(queue)).toEqual(['f']);
    });

    it('hands a requested delivery retry only to the worker that started the Run', () => {
      const queue = [retrying('r', 'p1')];

      expect(HandOutRule.for(W1).next(queue)?.id).toBe('r');
      expect(HandOutRule.for(W2).next(queue)).toBeUndefined();
    });

    it('does not hand out a failed Run without a requested retry, or one a worker holds', () => {
      expect(
        HandOutRule.for(W1).next([retrying('r', 'p1', { deliveryRequested: false })]),
      ).toBeUndefined();
      expect(HandOutRule.for(W1).next([retrying('r', 'p1', { claimedBy: W1 })])).toBeUndefined();
    });

    it('counts a failed Run a worker holds for a delivery retry as holding a place', () => {
      const held = retrying('r', 'p1', { claimedBy: W1 });

      expect(HandOutRule.for(W1).next([held, run('q', 'p1')])).toBeUndefined();
      expect(HandOutRule.for(W1).next([held, run('q', 'p2')])?.id).toBe('q');
    });
  });

  it.each(['succeeded', 'cancelled', 'timed_out', 'preparing', 'running'] as const)(
    'never hands out a %s Run',
    (state) => {
      const candidate = run('x', 'p1', {
        state,
        claimedBy: state === 'preparing' || state === 'running' ? W1 : null,
        lastClaimedBy: W1,
      });

      expect(HandOutRule.for(W1).next([candidate])).toBeUndefined();
    },
  );

  it('holds a place exactly for the states that hold one', () => {
    const base = { claimedBy: null, sessionRef: null, followUpQueued: false } as const;
    const rule = HandOutRule.for(W1);

    expect(rule.holdsPlace({ ...base, state: 'queued' })).toBe(false);
    expect(rule.holdsPlace({ ...base, state: 'queued', sessionRef: 's' })).toBe(true);
    expect(
      rule.holdsPlace({ ...base, state: 'queued', sessionRef: 's', followUpQueued: true }),
    ).toBe(false);
    expect(rule.holdsPlace({ ...base, state: 'failed' })).toBe(false);
    expect(rule.holdsPlace({ ...base, state: 'failed', claimedBy: W1 })).toBe(true);
    for (const state of ['preparing', 'running', 'waiting_for_operator'] as const) {
      expect(rule.holdsPlace({ ...base, state })).toBe(true);
    }
    for (const state of ['succeeded', 'cancelled', 'timed_out'] as const) {
      expect(rule.holdsPlace({ ...base, state })).toBe(false);
    }
  });
});
