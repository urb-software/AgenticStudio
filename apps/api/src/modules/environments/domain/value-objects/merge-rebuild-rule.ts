import type { PreviewStateName } from './preview-state.js';

/** What a waiting rebuild waits for. */
export type MergeRebuildWaitReason =
  | 'clone_not_ready'
  | 'clone_fetch'
  | 'build_active'
  | 'change_active'
  | 'controller'
  | 'free_place'
  | 'error';

/** The Clone of the Project's Repository, as far as the rule needs it. */
export type MergeRebuildRuleSource =
  | { readonly ready: false }
  | { readonly ready: true; readonly commit: string; readonly fetchedAt: Date | null };

export interface MergeRebuildRuleFacts {
  readonly state: PreviewStateName;
  /** The commit the Preview runs, or `null` when none does. */
  readonly runningCommit: string | null;
  readonly source: MergeRebuildRuleSource;
  readonly rebuild: { mergedCommit: string; fetchStartedAt: Date; recordedAt: Date };
  readonly now: Date;
}

export type MergeRebuildRuleDecision =
  | { action: 'wait'; reason: MergeRebuildWaitReason }
  | { action: 'drop' }
  | { action: 'build' }
  | { action: 'give_up'; reason: string };

const WAIT_TEXT: Record<MergeRebuildWaitReason, string> = {
  clone_not_ready: 'the Repository to be ready',
  clone_fetch: 'the Clone fetch to bring in the merge',
  build_active: 'the running build to finish',
  change_active: 'a stop or data removal to finish',
  controller: 'an environment controller',
  free_place: 'a free place of the running Previews limit',
  error: 'a problem on the Studio side to clear',
};

/** When a rebuild a merge asked for starts, waits, is dropped or is given up. */
export class MergeRebuildRule {
  static readonly GIVE_UP_MINUTES = 30;

  static create(): MergeRebuildRule {
    return new MergeRebuildRule();
  }

  /** `wait` carries what is awaited; `give_up` carries the last such reason in words. */
  decide(facts: MergeRebuildRuleFacts): MergeRebuildRuleDecision {
    const { state, runningCommit, source, rebuild, now } = facts;
    switch (state) {
      case 'stopped':
      case 'failed':
      case 'not_configured':
        return { action: 'drop' };
      case 'building':
        return this.waiting(rebuild, now, 'build_active');
      case 'stopping':
      case 'resetting_data':
        return this.waiting(rebuild, now, 'change_active');
      case 'running':
        break;
    }
    if (!source.ready) return this.waiting(rebuild, now, 'clone_not_ready');
    const holdsMerge =
      source.commit === rebuild.mergedCommit ||
      (source.fetchedAt !== null && source.fetchedAt >= rebuild.fetchStartedAt);
    if (!holdsMerge) return this.waiting(rebuild, now, 'clone_fetch');
    return runningCommit === source.commit ? { action: 'drop' } : { action: 'build' };
  }

  /** The decision for a rebuild that has to keep waiting: `give_up` once it waited long enough. */
  waiting(
    rebuild: { recordedAt: Date },
    now: Date,
    reason: MergeRebuildWaitReason,
  ): MergeRebuildRuleDecision {
    const limit = MergeRebuildRule.GIVE_UP_MINUTES * 60_000;
    if (now.getTime() - rebuild.recordedAt.getTime() < limit) return { action: 'wait', reason };
    return {
      action: 'give_up',
      reason:
        `The rebuild did not start within ${MergeRebuildRule.GIVE_UP_MINUTES} minutes: ` +
        `it was waiting for ${WAIT_TEXT[reason]}.`,
    };
  }
}
