import { CommitId } from './commit-id.js';
import type { MergeRefusal } from './merge-refusal.js';
import type { MergeStudioFacts } from './merge-studio-facts.js';

/** The refusals Studio decides alone, before any call to the Git host. */
export class MergeStudioRule {
  private constructor(private readonly facts: MergeStudioFacts) {}

  static of(facts: MergeStudioFacts): MergeStudioRule {
    return new MergeStudioRule(facts);
  }

  /** The first reason, in the order the operator can act on them, or `null` when none applies. */
  refusal(): MergeRefusal | null {
    const { facts } = this;
    if (facts.runActive) return 'run_active';
    if (!facts.hasPullRequest) return 'pull_request_not_open';
    if (facts.review.state !== 'ready') return 'review_out_of_date';
    return CommitId.of(facts.commit).equals(facts.review.runCommit) ? null : 'commit_moved';
  }
}
