import { describe, expect, it } from 'vitest';
import { CloseInProgressError, ClosePullRequestRefusedError } from '../../errors/run-errors.js';
import { Run } from '../run.js';
import { RunPullRequestStatus } from '../../value-objects/run-pull-request-status.js';
import { runData } from './run-fixtures.js';

const T0 = new Date('2026-11-21T12:00:00.000Z');
const T1 = new Date('2026-11-21T12:01:00.000Z');
const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };

const delivered = (overrides: Parameters<typeof runData>[0] = {}) =>
  Run.restore(
    runData({
      state: 'succeeded',
      finishedAt: T0,
      waitingSince: null,
      delivery: 'delivered',
      pullRequest: PULL_REQUEST,
      workingCopy: { runBranch: 'agent/x-r0b8e5c2d', commits: [], hasUncommittedChanges: false },
      ...overrides,
    }),
  );

describe('Run closing its pull request from Studio', () => {
  it.each(['queued', 'preparing', 'running', 'waiting_for_operator'] as const)(
    'is active while %s, and refuses the claim',
    (state) => {
      const run = delivered({ state, finishedAt: null });
      expect(run.isActive).toBe(true);
      expect(() => run.claimClose(T0)).toThrow(
        expect.objectContaining({ reason: 'run_active' }) as Error,
      );
    },
  );

  it('is active while a Follow-up is queued or a delivery retry is requested', () => {
    expect(delivered({ followUpQueued: true }).isActive).toBe(true);
    expect(delivered({ deliveryRequested: true }).isActive).toBe(true);
    expect(delivered().isActive).toBe(false);
  });

  it('refuses a Run without a pull request', () => {
    const run = delivered({ delivery: 'none', pullRequest: null });
    expect(() => run.claimClose(T0)).toThrow(ClosePullRequestRefusedError);
  });

  it('claims the close first, then the branch deletion, then there is nothing to do', () => {
    const run = delivered();
    expect(run.claimClose(T0)).toBe('close');
    expect(run.pullRequestStatus.closeClaimedAt).toEqual(T0);

    run.recordClosedFromStudio(T1);
    expect(run.pullRequestStatus).toMatchObject({
      state: 'closed',
      closedFromStudioAt: T1,
      endedAt: T1,
    });
    run.recordBranchDeleted(T1);
    expect(run.pullRequestStatus.closeClaimedAt).toBeNull();
    expect(run.claimClose(T1)).toBe('done');
    expect(run.pendingChanges().fields.pullRequestStatus).toEqual(run.pullRequestStatus.toData());
  });

  it('retries only the deletion after a failed one', () => {
    const run = delivered();
    run.claimClose(T0);
    run.recordClosedFromStudio(T0);
    run.recordBranchDeletionFailed('Branch protection.');

    expect(run.claimClose(T1)).toBe('delete_branch');
  });

  it('refuses a second claim while the first is fresh, and takes over a stale one', () => {
    const run = delivered();
    run.claimClose(T0);
    expect(() => run.claimClose(T1)).toThrow(CloseInProgressError);
    expect(run.claimClose(new Date(T0.getTime() + 120_000))).toBe('close');
  });

  it('releases the claim without recording a close', () => {
    const run = delivered();
    run.claimClose(T0);
    run.releaseCloseClaim();
    expect(run.pullRequestStatus).toMatchObject({ closeClaimedAt: null, closedFromStudioAt: null });
  });

  it('keeps the stored status shape intact', () => {
    expect(RunPullRequestStatus.none().closeProgress).toBe('not_closed');
  });
});
