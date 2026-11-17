/** Who cancelled a Run (Issue #100): the operator, or Studio itself (a Run waiting too long). */
export const RUN_CANCELLED_BY = ['operator', 'system'] as const;
export type RunCancelledBy = (typeof RUN_CANCELLED_BY)[number];

/** Why a Run was cancelled; set exactly when `cancelled`. */
export interface RunCancellation {
  by: RunCancelledBy;
  /** A short explanation, shown to the operator. */
  reason: string;
}

/**
 * The cancellation recorded when the operator's cancel arrived during the delivery, after the
 * Run branch was pushed but before a pull request was opened (review of #124).
 */
export const OPERATOR_CANCELLATION_BRANCH_PUSHED: RunCancellation = {
  by: 'operator',
  reason:
    'Cancelled by the operator during its delivery: the Run branch was pushed, no pull request was opened.',
};

/** What every cancellation by the operator starts with (the reasons here). */
export const OPERATOR_CANCELLATION_PREFIX = 'Cancelled by the operator';

/** The cancellation recorded when the operator cancels a Run (Issue #100). */
export const OPERATOR_CANCELLATION: RunCancellation = {
  by: 'operator',
  reason: `${OPERATOR_CANCELLATION_PREFIX}.`,
};
