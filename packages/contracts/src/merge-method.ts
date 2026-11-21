import { z } from 'zod';

/** How Studio asks the Git host to merge a Run's pull request. Rebase is not offered. */
export const MERGE_METHODS = ['squash', 'merge_commit'] as const;
export const mergeMethodSchema = z.enum(MERGE_METHODS);
export type MergeMethod = z.infer<typeof mergeMethodSchema>;

/** `PUT /api/projects/:id/merge-method` body. */
export const setMergeMethodRequestSchema = z.strictObject({ mergeMethod: mergeMethodSchema });
export type SetMergeMethodRequest = z.infer<typeof setMergeMethodRequestSchema>;
