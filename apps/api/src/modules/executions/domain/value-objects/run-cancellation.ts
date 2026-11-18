export const RUN_CANCELLED_BY = ['operator', 'system'] as const;
export type RunCancelledBy = (typeof RUN_CANCELLED_BY)[number];

export interface RunCancellation {
  by: RunCancelledBy;
  reason: string;
}

export const OPERATOR_CANCELLATION_BRANCH_PUSHED: RunCancellation = {
  by: 'operator',
  reason:
    'Cancelled by the operator during its delivery: the Run branch was pushed, no pull request was opened.',
};

export const OPERATOR_CANCELLATION_PREFIX = 'Cancelled by the operator';

export const OPERATOR_CANCELLATION: RunCancellation = {
  by: 'operator',
  reason: `${OPERATOR_CANCELLATION_PREFIX}.`,
};
