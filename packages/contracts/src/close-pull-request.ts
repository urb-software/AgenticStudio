import { z } from 'zod';

/** Why Studio refused to close a Run's pull request: the `reason` of a 409 on the close route. */
export const CLOSE_PULL_REQUEST_REFUSALS = [
  'run_active',
  'pull_request_not_open',
  'merge_unavailable',
  'host_refused',
] as const;
export const closePullRequestRefusalSchema = z.enum(CLOSE_PULL_REQUEST_REFUSALS);
export type ClosePullRequestRefusal = z.infer<typeof closePullRequestRefusalSchema>;

/**
 * What closing a pull request from Studio left behind; absent until it was closed. The Run
 * branch fields are set by a close and by a merge alike.
 */
export const pullRequestClosureSchema = z.strictObject({
  closedFromStudioAt: z.iso.datetime().optional(),
  runBranchDeletedAt: z.iso.datetime().optional(),
  /** The Git host's reason, redacted: the Run branch is still there. */
  runBranchDeletionFailure: z.string().max(500).optional(),
});
export type PullRequestClosure = z.infer<typeof pullRequestClosureSchema>;

/** The Pull request state after the close, with what it left behind. */
export const closePullRequestResponseSchema = pullRequestClosureSchema.extend({
  state: z.enum(['draft', 'open', 'merged', 'closed', 'missing']),
  closedFromStudioAt: z.iso.datetime(),
});
export type ClosePullRequestResponse = z.infer<typeof closePullRequestResponseSchema>;
