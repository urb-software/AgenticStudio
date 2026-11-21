export const MERGE_METHODS = ['squash'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];
