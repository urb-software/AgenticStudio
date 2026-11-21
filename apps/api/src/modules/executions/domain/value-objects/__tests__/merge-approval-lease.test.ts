import { describe, expect, it } from 'vitest';
import { MergeApprovalLease } from '../merge-approval-lease.js';

const APPROVED = new Date('2026-11-21T12:00:00.000Z');
const after = (seconds: number) => new Date(APPROVED.getTime() + seconds * 1000);

describe('MergeApprovalLease', () => {
  it('is over only once the approval is older than the lease', () => {
    expect(MergeApprovalLease.at(after(MergeApprovalLease.SECONDS)).isOver(APPROVED)).toBe(false);
    expect(MergeApprovalLease.at(after(MergeApprovalLease.SECONDS + 1)).isOver(APPROVED)).toBe(
      true,
    );
  });

  it('keeps room for one more host step: none starts in the last minute of the lease', () => {
    const limit = MergeApprovalLease.SECONDS - MergeApprovalLease.STEP_BUDGET_SECONDS;

    expect(MergeApprovalLease.at(after(limit - 1)).allowsAStep(APPROVED)).toBe(true);
    expect(MergeApprovalLease.at(after(limit)).allowsAStep(APPROVED)).toBe(false);
  });

  it('allows the three host steps of a request whose calls all take their full time out', () => {
    const worstCaseSeconds = 3 * 2 * 15;

    expect(MergeApprovalLease.SECONDS - MergeApprovalLease.STEP_BUDGET_SECONDS).toBeGreaterThan(
      worstCaseSeconds,
    );
  });
});
