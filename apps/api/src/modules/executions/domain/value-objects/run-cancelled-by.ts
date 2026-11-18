export const RUN_CANCELLED_BY = ['operator', 'system'] as const;
export type RunCancelledBy = (typeof RUN_CANCELLED_BY)[number];
