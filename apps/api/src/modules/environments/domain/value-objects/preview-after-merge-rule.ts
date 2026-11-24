export const PREVIEW_AFTER_MERGE_STATE_NAMES = [
  'not_configured',
  'not_started',
  'waiting',
  'building',
  'running',
  'failed',
  'replaced',
] as const;

export type PreviewAfterMergeStateName = (typeof PREVIEW_AFTER_MERGE_STATE_NAMES)[number];

export interface PreviewAfterMergeRuleFacts {
  readonly runId: string;
  readonly configured: boolean;
  /** The build the Preview runs now, or `null` when none does. */
  readonly runningBuildId: string | null;
  /** The Project's waiting rebuild, whichever Run asked for it. */
  readonly rebuild: { runId: string; failed: boolean } | null;
  /** The newest build started by the Run's merge, or made of the merged commit. */
  readonly build: { id: string; status: string } | null;
}

/** What the Preview is for a merged Run's commit, from the rebuild and the builds. */
export class PreviewAfterMergeRule {
  static create(): PreviewAfterMergeRule {
    return new PreviewAfterMergeRule();
  }

  state(facts: PreviewAfterMergeRuleFacts): PreviewAfterMergeStateName {
    const { runId, configured, runningBuildId, rebuild, build } = facts;
    if (!configured) return 'not_configured';
    if (rebuild !== null && rebuild.runId === runId) return rebuild.failed ? 'failed' : 'waiting';
    if (build !== null) {
      if (build.status === 'requested' || build.status === 'claimed') return 'building';
      if (build.status === 'failed') return 'failed';
      return runningBuildId === build.id ? 'running' : 'replaced';
    }
    return rebuild !== null ? 'replaced' : 'not_started';
  }
}
