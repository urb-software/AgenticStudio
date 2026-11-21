import { GitHubRepository } from './git-hub-repository.js';
import type { MergeUnavailableReason } from './merge-unavailable-reason.js';

/** Whether Studio can merge or close a Run's pull request, from facts alone (no host call). */
export class MergeAvailabilityRule {
  private constructor(
    private readonly configured: boolean,
    private readonly allowFileRemotes: boolean,
  ) {}

  /** `configured`: the Merge credential is set. */
  static of(facts: { configured: boolean; allowFileRemotes: boolean }): MergeAvailabilityRule {
    return new MergeAvailabilityRule(facts.configured, facts.allowFileRemotes);
  }

  /** Why merging is not possible, or `null` when it is. */
  unavailableReason(remoteUrl: string): MergeUnavailableReason | null {
    if (!this.configured) return 'not_configured';
    const repository = GitHubRepository.fromRemote(remoteUrl, {
      allowFileRemotes: this.allowFileRemotes,
    });
    return repository === null ? 'unsupported_host' : null;
  }
}
