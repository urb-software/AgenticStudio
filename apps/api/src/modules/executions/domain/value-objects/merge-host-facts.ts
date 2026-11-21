/** What the Git host answered about the pull request and its checks just before a merge. */
export interface MergeHostFacts {
  /** The commit the operator approved. */
  commit: string;
  pullRequest: {
    state: 'open' | 'closed' | 'merged';
    headSha: string;
    /** `null` while the host has not computed it yet. */
    mergeable: boolean | null;
    mergeableState: string;
  };
  checks: readonly { name: string; state: 'success' | 'failure' | 'pending' | 'neutral' }[];
}
