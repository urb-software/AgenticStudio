import { CommitId } from './commit-id.js';
import type { MergeHostFacts } from './merge-host-facts.js';
import type { MergeRefusal } from './merge-refusal.js';

/** The refusals Studio reaches by reading the pull request and its checks itself. */
export class MergeHostRule {
  private constructor(private readonly facts: MergeHostFacts) {}

  static of(facts: MergeHostFacts): MergeHostRule {
    return new MergeHostRule(facts);
  }

  /** The first reason, or `null` when the pull request may be merged. */
  refusal(): MergeRefusal | null {
    const { commit, pullRequest, checks } = this.facts;
    if (pullRequest.state !== 'open') return 'pull_request_not_open';
    if (!CommitId.of(commit).equals(pullRequest.headSha)) return 'commit_moved';
    if (checks.some((check) => check.state === 'failure')) return 'checks_failing';
    if (checks.some((check) => check.state === 'pending')) return 'checks_running';
    if (pullRequest.mergeable === false || pullRequest.mergeableState === 'dirty') {
      return 'conflicting';
    }
    // The host is still computing it: waiting is the honest answer, not a guess.
    return pullRequest.mergeable === null ? 'checks_running' : null;
  }
}
