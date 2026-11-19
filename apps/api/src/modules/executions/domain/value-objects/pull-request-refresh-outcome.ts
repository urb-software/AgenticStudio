/** `no_worker`: a refresh was asked for but no agent worker is connected to carry it out. */
export type PullRequestRefreshOutcome = 'refreshing' | 'no_worker' | 'idle';
