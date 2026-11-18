/**
 * `missing`: the pull request, or the Run branch it came from, no longer exists. The worker
 * protocol's list is pinned to this one by a test.
 */
export const PULL_REQUEST_STATES = ['draft', 'open', 'merged', 'closed', 'missing'] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

export type EndedPullRequestState = Extract<PullRequestState, 'merged' | 'closed' | 'missing'>;

export function isEndedPullRequestState(
  state: PullRequestState | null,
): state is EndedPullRequestState {
  return state === 'merged' || state === 'closed' || state === 'missing';
}
