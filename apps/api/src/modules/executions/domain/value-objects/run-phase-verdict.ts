export const RUN_PHASE_VERDICTS = ['approved', 'changes_requested'] as const;
export type RunPhaseVerdict = (typeof RUN_PHASE_VERDICTS)[number];
