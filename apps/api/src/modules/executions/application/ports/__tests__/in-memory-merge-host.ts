import type {
  HostCheck,
  HostMergeRequest,
  HostPullRequest,
  MergeHost,
  MergeHostFailure,
  MergeHostResult,
  PullRequestScope,
} from '../merge-host.js';
import { RunBranchRule } from '../../../domain/value-objects/run-branch-rule.js';

export type MergeHostMethod =
  | 'readPullRequest'
  | 'readChecks'
  | 'markReady'
  | 'approve'
  | 'merge'
  | 'close'
  | 'deleteRunBranch';

export interface MergeHostCall {
  method: MergeHostMethod;
  scope: PullRequestScope;
  sha?: string;
  merge?: HostMergeRequest;
}

const OPEN_PULL_REQUEST: HostPullRequest = {
  state: 'open',
  draft: false,
  headSha: 'a'.repeat(40),
  headRef: '',
  baseRef: 'dev',
  mergeable: true,
  mergeableState: 'clean',
  mergedCommit: null,
  title: 'Add a health check',
  body: 'Adds GET /health.',
};

/** The commit a successful merge creates, unless a test sets another. */
export const MERGED_COMMIT = 'f'.repeat(40);

/** A MergeHost for unit and integration tests: set what it answers, then read what it was asked. */
export class InMemoryMergeHost implements MergeHost {
  readonly calls: MergeHostCall[] = [];
  /** An empty `headRef` means the pull request's head is the Run branch of the scope. */
  private pullRequest: HostPullRequest = { ...OPEN_PULL_REQUEST };
  private checks: HostCheck[] = [];
  private readonly refusals = new Map<MergeHostMethod, MergeHostFailure>();
  private branchDeleted = false;
  private readonly gates = new Map<MergeHostMethod, Promise<void>>();

  setPullRequest(pullRequest: Partial<HostPullRequest>): void {
    this.pullRequest = { ...this.pullRequest, ...pullRequest };
  }

  setChecks(checks: HostCheck[]): void {
    this.checks = [...checks];
  }

  /** Every later call of `method` answers `failure`; `null` removes it. */
  refuse(method: MergeHostMethod, failure: MergeHostFailure | null): void {
    if (failure === null) this.refusals.delete(method);
    else this.refusals.set(method, failure);
  }

  /** The next call of `method` waits for the returned release, after it was recorded. */
  hold(method: MergeHostMethod): () => void {
    let release = () => undefined as void;
    this.gates.set(
      method,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  }

  private async takeGate(method: MergeHostMethod): Promise<void> {
    const gate = this.gates.get(method);
    this.gates.delete(method);
    await gate;
  }

  get runBranchDeleted(): boolean {
    return this.branchDeleted;
  }

  async readPullRequest(scope: PullRequestScope) {
    return this.answer('readPullRequest', scope, {}, () => ({
      ok: true as const,
      pullRequest: { ...this.pullRequest, headRef: this.pullRequest.headRef || scope.runBranch },
    }));
  }

  async readChecks(scope: PullRequestScope, sha: string) {
    return this.answer('readChecks', scope, { sha }, () => ({
      ok: true as const,
      checks: [...this.checks],
    }));
  }

  async markReady(scope: PullRequestScope) {
    this.calls.push({ method: 'markReady', scope });
    await this.takeGate('markReady');
    return this.decide('markReady', scope, () => {
      this.pullRequest = { ...this.pullRequest, draft: false };
      return { ok: true as const };
    });
  }

  async approve(scope: PullRequestScope, sha: string) {
    return this.answer('approve', scope, { sha }, () => ({ ok: true as const }));
  }

  async merge(scope: PullRequestScope, request: HostMergeRequest) {
    this.calls.push({ method: 'merge', scope, sha: request.sha, merge: request });
    await this.takeGate('merge');
    return this.decide('merge', scope, (): MergeHostResult<{ mergedCommit: string }> => {
      if (request.sha !== this.pullRequest.headSha) {
        return { ok: false, failure: { code: 'refused', message: 'Head branch was modified.' } };
      }
      this.pullRequest = { ...this.pullRequest, state: 'merged', mergedCommit: MERGED_COMMIT };
      return { ok: true, mergedCommit: MERGED_COMMIT };
    });
  }

  async close(scope: PullRequestScope) {
    return this.answer('close', scope, {}, () => {
      this.pullRequest = { ...this.pullRequest, state: 'closed' };
      return { ok: true as const };
    });
  }

  async deleteRunBranch(scope: PullRequestScope) {
    return this.answer('deleteRunBranch', scope, {}, () => {
      this.branchDeleted = true;
      return { ok: true as const };
    });
  }

  private answer<T extends object>(
    method: MergeHostMethod,
    scope: PullRequestScope,
    details: Pick<MergeHostCall, 'sha' | 'merge'>,
    succeed: () => MergeHostResult<T>,
  ): MergeHostResult<T> {
    this.calls.push({ method, scope, ...details });
    return this.decide(method, scope, succeed);
  }

  private decide<T extends object>(
    method: MergeHostMethod,
    scope: PullRequestScope,
    succeed: () => MergeHostResult<T>,
  ): MergeHostResult<T> {
    const ownBranch = RunBranchRule.of(scope.runId, scope.integrationBranch).accepts(
      scope.runBranch,
    );
    if (
      !ownBranch ||
      (this.pullRequest.headRef !== '' && this.pullRequest.headRef !== scope.runBranch)
    ) {
      return { ok: false, failure: { code: 'scope_mismatch' } };
    }
    const failure = this.refusals.get(method);
    return failure ? { ok: false, failure } : succeed();
  }
}
