/** How a Project's Runs are merged. Rebase is not a value. */
export const MERGE_METHODS = ['squash', 'merge_commit'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export function isMergeMethod(value: unknown): value is MergeMethod {
  return typeof value === 'string' && (MERGE_METHODS as readonly string[]).includes(value);
}
