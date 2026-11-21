import type {
  HostCheck,
  HostMergeRequest,
  HostPullRequest,
  MergeHost,
  MergeHostFailure,
  MergeHostResult,
  PullRequestScope,
} from '../../application/ports/merge-host.js';

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
  headRef: 'agent/task-r00000000',
  baseRef: 'dev',
  mergeable: true,
  mergeableState: 'clean',
};

/** A MergeHost for unit and integration tests: set what it answers, then read what it was asked. */
export class InMemoryMergeHost implements MergeHost {
  readonly calls: MergeHostCall[] = [];
  private pullRequest: HostPullRequest = { ...OPEN_PULL_REQUEST };
  private checks: HostCheck[] = [];
  private readonly refusals = new Map<MergeHostMethod, MergeHostFailure>();
  private branchDeleted = false;

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

  get runBranchDeleted(): boolean {
    return this.branchDeleted;
  }

  async readPullRequest(scope: PullRequestScope) {
    return this.answer('readPullRequest', scope, {}, () => ({
      ok: true as const,
      pullRequest: { ...this.pullRequest },
    }));
  }

  async readChecks(scope: PullRequestScope, sha: string) {
    return this.answer('readChecks', scope, { sha }, () => ({
      ok: true as const,
      checks: [...this.checks],
    }));
  }

  async markReady(scope: PullRequestScope) {
    return this.answer('markReady', scope, {}, () => {
      this.pullRequest = { ...this.pullRequest, draft: false };
      return { ok: true as const };
    });
  }

  async approve(scope: PullRequestScope, sha: string) {
    return this.answer('approve', scope, { sha }, () => ({ ok: true as const }));
  }

  async merge(scope: PullRequestScope, request: HostMergeRequest) {
    return this.answer(
      'merge',
      scope,
      { sha: request.sha, merge: request },
      (): MergeHostResult => {
        if (request.sha !== this.pullRequest.headSha) {
          return { ok: false, failure: { code: 'refused', message: 'Head branch was modified.' } };
        }
        this.pullRequest = { ...this.pullRequest, state: 'merged' };
        return { ok: true };
      },
    );
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
    const failure = this.refusals.get(method);
    return failure ? { ok: false, failure } : succeed();
  }
}
