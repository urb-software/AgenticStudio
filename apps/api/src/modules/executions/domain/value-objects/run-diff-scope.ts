/**
 * Patches are redacted like the log before they are stored. The domain owns these lists; a test
 * pins the worker protocol's and the HTTP contract's to them.
 */
export const RUN_DIFF_SCOPES = ['run', 'last'] as const;
export type RunDiffScope = (typeof RUN_DIFF_SCOPES)[number];
