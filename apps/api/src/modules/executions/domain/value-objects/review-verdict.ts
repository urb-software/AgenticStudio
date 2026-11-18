export const REVIEW_VERDICTS = ['commented', 'changes_requested', 'approved'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
