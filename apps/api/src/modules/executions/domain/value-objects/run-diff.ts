/**
 * A Run's diff of one scope (Issue #144): `run`, everything the Run changed since its start
 * commit, or `last`, what changed since the previous result. The agent worker computes both
 * from the Working copy after every Run step's result; Studio keeps the latest of each, after
 * the Working copy is gone. The patches are redacted like the log before they are stored.
 *
 * The domain owns these lists; a test pins the worker protocol's and the HTTP contract's to them.
 */
export const RUN_DIFF_SCOPES = ['run', 'last'] as const;
export type RunDiffScope = (typeof RUN_DIFF_SCOPES)[number];

/** How a file changed. */
export const RUN_DIFF_FILE_STATUSES = ['added', 'modified', 'deleted', 'renamed'] as const;
export type RunDiffFileStatus = (typeof RUN_DIFF_FILE_STATUSES)[number];

/** Longest reason a diff could not be computed, as stored (after redaction, which can lengthen it). */
export const RUN_DIFF_UNAVAILABLE_MAX_LENGTH = 500;

/**
 * Whether a diff file's path is the Run's Environment file path (review L-3 of #149): compared
 * without a leading `./` or `/`, so another spelling of the same path is caught too.
 */
export function isEnvironmentFilePath(path: string, environmentFilePath: string | null): boolean {
  if (environmentFilePath === null) return false;
  const normalise = (value: string) => value.replace(/^(?:\.\/|\/)+/, '');
  return normalise(path) === normalise(environmentFilePath);
}
