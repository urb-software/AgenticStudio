import type { RepositoryJobs, RepositoryOperation } from '../repository-jobs.js';

/**
 * Records scheduled operations as `[projectId, operation]` and cancels by project id;
 * `failWith` makes `start` reject, `cancelFailsWith` makes `cancel` reject, and `onCancel`
 * runs inside `cancel` (e.g. the last write of the job being cancelled).
 */
export class RecordingRepositoryJobs implements RepositoryJobs {
  readonly started: [string, RepositoryOperation][] = [];
  readonly cancelled: string[] = [];
  failWith: Error | undefined;
  cancelFailsWith: Error | undefined;
  onCancel: ((projectId: string) => Promise<void>) | undefined;

  async cancel(projectId: string): Promise<void> {
    this.cancelled.push(projectId);
    if (this.cancelFailsWith) throw this.cancelFailsWith;
    await this.onCancel?.(projectId);
  }

  start(projectId: string, operation: RepositoryOperation): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.started.push([projectId, operation]);
    return Promise.resolve();
  }
}
