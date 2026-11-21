export const MERGE_CHECK_STATES = ['success', 'failure', 'pending', 'neutral'] as const;

export interface MergeCheckSeen {
  readonly name: string;
  readonly state: (typeof MERGE_CHECK_STATES)[number];
}
