import type { RepositoryJobs, RepositoryOperation } from '../repository-jobs.js';

/** Records scheduled operations as `[projectId, operation]`; `failWith` makes `start` reject. */
export class RecordingRepositoryJobs implements RepositoryJobs {
  readonly started: [string, RepositoryOperation][] = [];
  failWith: Error | undefined;

  start(projectId: string, operation: RepositoryOperation): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.started.push([projectId, operation]);
    return Promise.resolve();
  }
}
