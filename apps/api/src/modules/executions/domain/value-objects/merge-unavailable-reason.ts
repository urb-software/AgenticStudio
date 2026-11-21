export const MERGE_UNAVAILABLE_REASONS = ['not_configured', 'unsupported_host'] as const;
export type MergeUnavailableReason = (typeof MERGE_UNAVAILABLE_REASONS)[number];
