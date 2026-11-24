import { describe, expect, it } from 'vitest';
import { LostControllerRule } from '../lost-controller-rule.js';
import { OverdueBuildRule } from '../overdue-build-rule.js';
import { PreviewRunningRule } from '../preview-running-rule.js';
import { UnclaimedOperationRule } from '../unclaimed-operation-rule.js';
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

describe('OverdueBuildRule', () => {
  const rule = OverdueBuildRule.at(NOW);
  const view = (
    claimedAt: number | null,
    over: Partial<Parameters<OverdueBuildRule['selects']>[0]> = {},
  ): Parameters<OverdueBuildRule['selects']>[0] => ({
    status: 'claimed',
    kind: 'build',
    claimedAt: claimedAt === null ? null : seconds(claimedAt),
    buildMinutes: 20,
    ...over,
  });

  it('selects a claimed build past its limit plus five minutes', () => {
    expect(rule.selects(view(-(25 * 60) - 1))).toBe(true);
    expect(rule.selects(view(-(25 * 60)))).toBe(false);
    expect(rule.selects(view(-60))).toBe(false);
  });

  it('uses the time limit of the build itself', () => {
    expect(rule.selects(view(-(7 * 60), { buildMinutes: 1 }))).toBe(true);
    expect(rule.selects(view(-(7 * 60), { buildMinutes: 2 }))).toBe(false);
  });

  it('selects nothing else', () => {
    expect(rule.selects(view(-9999, { kind: 'stop', buildMinutes: null }))).toBe(false);
    expect(rule.selects(view(-9999, { status: 'requested' }))).toBe(false);
    expect(rule.selects(view(-9999, { status: 'failed' }))).toBe(false);
    expect(rule.selects(view(null))).toBe(false);
  });

  it('fails with report_overdue', () => {
    expect(rule.failure.code).toBe('report_overdue');
  });
});

describe('UnclaimedOperationRule', () => {
  const rule = UnclaimedOperationRule.at(NOW, 5);

  it('selects a requested operation older than the limit', () => {
    expect(rule.selects({ status: 'requested', requestedAt: seconds(-301) })).toBe(true);
    expect(rule.selects({ status: 'requested', requestedAt: seconds(-300) })).toBe(false);
    expect(rule.selects({ status: 'requested', requestedAt: seconds(-10) })).toBe(false);
  });

  it('selects nothing else', () => {
    for (const status of ['claimed', 'succeeded', 'failed']) {
      expect(rule.selects({ status, requestedAt: seconds(-9999) })).toBe(false);
    }
  });

  it('fails with not_claimed, naming the minutes', () => {
    expect(rule.failure.code).toBe('not_claimed');
    expect(rule.failure.detail).toContain('5 minutes');
  });
});

describe('PreviewRunningRule', () => {
  const changes = (kind: string, status: string, previewRemoved = false) =>
    PreviewRunningRule.create().changesRunning({ kind, status, previewRemoved });

  it('counts a succeeded build, stop or data removal', () => {
    expect(changes('build', 'succeeded')).toBe(true);
    expect(changes('stop', 'succeeded')).toBe(true);
    expect(changes('remove_data', 'succeeded')).toBe(true);
  });

  it('counts a failed build only when it removed the Preview', () => {
    expect(changes('build', 'failed', true)).toBe(true);
    expect(changes('build', 'failed', false)).toBe(false);
  });

  it('counts a succeeded state check only when it found the Preview gone', () => {
    expect(changes('state', 'succeeded', true)).toBe(true);
    expect(changes('state', 'succeeded', false)).toBe(false);
    expect(changes('state', 'failed', true)).toBe(false);
  });

  it('counts nothing else', () => {
    expect(changes('state', 'succeeded')).toBe(false);
    expect(changes('stop', 'failed', true)).toBe(false);
    expect(changes('build', 'claimed')).toBe(false);
    expect(changes('build', 'requested')).toBe(false);
  });
});
