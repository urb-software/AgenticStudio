import { describe, expect, it } from 'vitest';
import { RunCancellation } from '../run-cancellation.js';

describe('RunCancellation', () => {
  it('words the operator cancellations as before', () => {
    expect(RunCancellation.OPERATOR).toMatchObject({
      by: 'operator',
      reason: 'Cancelled by the operator.',
    });
    expect(
      RunCancellation.OPERATOR_BRANCH_PUSHED.reason.startsWith(RunCancellation.OPERATOR_PREFIX),
    ).toBe(true);
  });

  it('words the automatic cancellation after a long wait, in the singular and the plural', () => {
    expect(RunCancellation.afterWaiting(1).reason).toBe(
      'Cancelled automatically: the run waited for the operator longer than 1 day.',
    );
    expect(RunCancellation.afterWaiting(14)).toMatchObject({
      by: 'system',
      reason: 'Cancelled automatically: the run waited for the operator longer than 14 days.',
    });
  });
});
