import { describe, expect, it } from 'vitest';
import { LostControllerRule } from '../lost-controller-rule.js';
import { PreviewOperationHandOutRule } from '../preview-operation-hand-out-rule.js';
import type { PreviewOperationQueueView } from '../preview-operation-queue-view.js';

const NOW = new Date('2026-11-24T10:00:00.000Z');
const LEASE = 60;
const seconds = (count: number) => new Date(NOW.getTime() + count * 1000);

function view(
  id: string,
  project: string,
  status: PreviewOperationQueueView['status'],
  requested: number,
  heartbeat: number | null = null,
): PreviewOperationQueueView {
  return {
    id,
    projectId: project,
    status,
    requestedAt: seconds(requested),
    heartbeatAt: heartbeat === null ? null : seconds(heartbeat),
  };
}

describe('LostControllerRule', () => {
  const rule = LostControllerRule.at(NOW, LEASE);

  it('selects a claimed operation whose last report is older than the lease', () => {
    expect(rule.selects(view('a', 'p', 'claimed', -300, -61))).toBe(true);
    expect(rule.selects(view('a', 'p', 'claimed', -300, -60))).toBe(false);
    expect(rule.selects(view('a', 'p', 'claimed', -300, -5))).toBe(false);
  });

  it('selects nothing else', () => {
    expect(rule.selects(view('a', 'p', 'requested', -300))).toBe(false);
    expect(rule.selects(view('a', 'p', 'succeeded', -300))).toBe(false);
    expect(rule.selects(view('a', 'p', 'failed', -300))).toBe(false);
  });

  it('fails with controller_lost, naming the lease and no secret', () => {
    expect(rule.failure.code).toBe('controller_lost');
    expect(rule.failure.detail).toContain('60 seconds');
    expect(rule.staleBefore).toEqual(seconds(-60));
  });
});

describe('PreviewOperationHandOutRule', () => {
  const rule = PreviewOperationHandOutRule.at(NOW, LEASE);
  const next = (operations: PreviewOperationQueueView[]) => rule.next(operations)?.id;

  it('hands out the oldest requested operation', () => {
    expect(next([view('b', 'p2', 'requested', -50), view('a', 'p1', 'requested', -100)])).toBe('a');
  });

  it('breaks a tie by id', () => {
    expect(next([view('b', 'p2', 'requested', -50), view('a', 'p1', 'requested', -50)])).toBe('a');
  });

  it('waits while the Project has a claimed operation, and hands out another Project first', () => {
    expect(
      next([
        view('held', 'p1', 'claimed', -200, -5),
        view('blocked', 'p1', 'requested', -100),
        view('free', 'p2', 'requested', -10),
      ]),
    ).toBe('free');
    expect(
      next([view('held', 'p1', 'claimed', -200, -5), view('blocked', 'p1', 'requested', -100)]),
    ).toBeUndefined();
  });

  it('does not let a lost claim hold its Project', () => {
    expect(
      next([view('lost', 'p1', 'claimed', -200, -120), view('after', 'p1', 'requested', -100)]),
    ).toBe('after');
  });

  it('never hands out a lost, final or claimed operation', () => {
    expect(
      next([
        view('lost', 'p1', 'claimed', -200, -120),
        view('done', 'p2', 'succeeded', -200),
        view('failed', 'p3', 'failed', -200),
      ]),
    ).toBeUndefined();
  });

  it('hands out nothing when nothing is requested', () => {
    expect(next([])).toBeUndefined();
  });
});
