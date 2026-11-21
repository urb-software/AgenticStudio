/** How a Merge approval records the merge: the Project's setting when it was approved. */
export const MERGE_METHODS = ['squash', 'merge_commit'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];
