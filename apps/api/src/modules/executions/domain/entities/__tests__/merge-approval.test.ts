import { describe, expect, it } from 'vitest';
import { MergeApprovalLease } from '../../value-objects/merge-approval-lease.js';
import { MergeApproval } from '../merge-approval.js';

const APPROVED = new Date('2026-11-21T12:00:00.000Z');
const LATER = new Date('2026-11-21T12:00:05.000Z');

function pending(): MergeApproval {
  return MergeApproval.approve(
    {
      id: 'e0000000-0000-4000-8000-000000000001',
      runId: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
      commit: 'b'.repeat(40),
      integrationBranch: 'dev',
      method: 'squash',
      checksSeen: [{ name: 'ci', state: 'success' }],
    },
    APPROVED,
  );
}

describe('MergeApproval', () => {
  it('starts pending, by the operator, with the commit and the checks seen', () => {
    expect(pending()).toMatchObject({
      approvedAt: APPROVED,
      approvedBy: 'operator',
      commit: 'b'.repeat(40),
      integrationBranch: 'dev',
      method: 'squash',
      checksSeen: [{ name: 'ci', state: 'success' }],
      result: 'pending',
      refusal: null,
      mergedCommit: null,
      completedAt: null,
      cloneFetchStartedAt: null,
    });
    expect(pending().isPending).toBe(true);
  });

  it('is carried out with the merged commit, and keeps what it recorded before', () => {
    const done = pending().carriedOut('f'.repeat(40), LATER);

    expect(done).toMatchObject({
      result: 'carried_out',
      mergedCommit: 'f'.repeat(40),
      completedAt: LATER,
      commit: 'b'.repeat(40),
      checksSeen: [{ name: 'ci', state: 'success' }],
    });
    expect(done.isCarriedOut).toBe(true);
  });

  it('is not carried out with a code and a reason cut to what is stored', () => {
    const refused = pending().notCarriedOut('host_refused', 'x'.repeat(900), LATER);

    expect(refused.result).toBe('not_carried_out');
    expect(refused.refusal?.code).toBe('host_refused');
    expect(refused.refusal?.reason).toHaveLength(MergeApproval.REASON_MAX_LENGTH);
    expect(refused.mergedCommit).toBeNull();
  });

  it('records when the Clone fetch after the merge started', () => {
    expect(pending().carriedOut('f'.repeat(40), LATER).cloneFetchStarted(LATER)).toMatchObject({
      cloneFetchStartedAt: LATER,
      result: 'carried_out',
    });
  });

  it('reads a pending approval older than its lease as interrupted, and a newer one as pending', () => {
    const lease = MergeApprovalLease.SECONDS * 1000;

    expect(pending().asOf(new Date(APPROVED.getTime() + lease - 1)).result).toBe('pending');
    const stale = pending().asOf(new Date(APPROVED.getTime() + lease + 1));
    expect(stale.result).toBe('not_carried_out');
    expect(stale.refusal).toEqual({ code: 'interrupted', reason: MergeApproval.INTERRUPTED });
  });

  it('may have merged unseen only when the merge call went out and its outcome is unknown', () => {
    const requested = pending().mergeRequested(APPROVED);

    expect(requested.mergeOutcomeUnknown).toBe(false);
    expect(requested.notCarriedOut('interrupted', 'Cut off.', LATER).mergeOutcomeUnknown).toBe(
      true,
    );
    expect(requested.notCarriedOut('host_refused', 'No.', LATER).mergeOutcomeUnknown).toBe(false);
    expect(pending().notCarriedOut('interrupted', 'Gone.', LATER).mergeOutcomeUnknown).toBe(false);
    expect(requested.carriedOut('f'.repeat(40), LATER).mergeOutcomeUnknown).toBe(false);
  });

  it('reads a pending approval whose merge call went out as unknown once it is stale', () => {
    const stale = pending()
      .mergeRequested(APPROVED)
      .asOf(new Date(APPROVED.getTime() + MergeApprovalLease.SECONDS * 1000 + 1));

    expect(stale.mergeOutcomeUnknown).toBe(true);
  });

  it('never reads a finished approval as interrupted', () => {
    const done = pending().carriedOut('f'.repeat(40), LATER);

    expect(done.asOf(new Date(APPROVED.getTime() + 3_600_000))).toBe(done);
  });
});
