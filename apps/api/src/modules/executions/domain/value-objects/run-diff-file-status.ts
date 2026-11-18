export const RUN_DIFF_FILE_STATUSES = ['added', 'modified', 'deleted', 'renamed'] as const;
export type RunDiffFileStatus = (typeof RUN_DIFF_FILE_STATUSES)[number];
