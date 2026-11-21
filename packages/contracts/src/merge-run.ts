import { z } from 'zod';
import { pullRequestClosureSchema } from './close-pull-request.js';
import { mergeMethodSchema } from './merge-method.js';

/** Why Studio refused an "Approve and merge": the `reason` of a 409 on the merge route. */
export const MERGE_REFUSALS = [
  'checks_failing',
  'checks_running',
  'conflicting',
  'run_active',
  'commit_moved',
  'review_out_of_date',
  'pull_request_not_open',
  'merge_unavailable',
  'host_refused',
  'merge_in_progress',
] as const;
export const mergeRefusalSchema = z.enum(MERGE_REFUSALS);
export type MergeRefusal = z.infer<typeof mergeRefusalSchema>;

/** A stored refusal also says when a request ended before it recorded a result. */
export const MERGE_APPROVAL_REFUSAL_CODES = [...MERGE_REFUSALS, 'interrupted'] as const;
export type MergeApprovalRefusalCode = (typeof MERGE_APPROVAL_REFUSAL_CODES)[number];

export const MERGE_APPROVAL_RESULTS = ['pending', 'carried_out', 'not_carried_out'] as const;
export const mergeApprovalResultSchema = z.enum(MERGE_APPROVAL_RESULTS);
export type MergeApprovalResult = z.infer<typeof mergeApprovalResultSchema>;

export const MERGE_CHECK_STATES = ['success', 'failure', 'pending', 'neutral'] as const;

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** The commit the operator reviewed, as a full commit id. */
export const mergeRunRequestSchema = z.strictObject({
  commit: z.string().regex(COMMIT_ID, 'Must be a full commit id (40 or 64 hex characters).'),
});
export type MergeRunRequest = z.infer<typeof mergeRunRequestSchema>;

/** One check as Studio read it from the Git host just before it merged. */
export const mergeCheckSeenSchema = z.strictObject({
  name: z.string(),
  state: z.enum(MERGE_CHECK_STATES),
});
export type MergeCheckSeen = z.infer<typeof mergeCheckSeenSchema>;

/**
 * The record stored when the operator pressed "Approve and merge", kept whatever happened next.
 * `refusal.reason` is the Git host's, redacted.
 */
export const mergeApprovalSchema = z.strictObject({
  id: z.uuid(),
  approvedAt: z.iso.datetime(),
  approvedBy: z.literal('operator'),
  commit: z.string(),
  integrationBranch: z.string(),
  method: mergeMethodSchema,
  checksSeen: z.array(mergeCheckSeenSchema),
  result: mergeApprovalResultSchema,
  refusal: z
    .strictObject({
      code: z.enum(MERGE_APPROVAL_REFUSAL_CODES),
      reason: z.string().max(500),
    })
    .optional(),
  mergedCommit: z.string().optional(),
  completedAt: z.iso.datetime().optional(),
  /** Present when the merge may have been carried out although the record says it was not. */
  mergeOutcomeUnknown: z.literal(true).optional(),
  /** Absent until the Project's Clone fetch started after the merge. */
  cloneFetchStartedAt: z.iso.datetime().optional(),
});
export type MergeApproval = z.infer<typeof mergeApprovalSchema>;

/** The Merge approval with what the merge left behind on the Run branch. */
export const mergeRunResponseSchema = mergeApprovalSchema.extend(
  pullRequestClosureSchema.pick({ runBranchDeletedAt: true, runBranchDeletionFailure: true }).shape,
);
export type MergeRunResponse = z.infer<typeof mergeRunResponseSchema>;
