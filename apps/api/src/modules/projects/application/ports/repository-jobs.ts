/** DI token for the {@link RepositoryJobs} port. */
export const REPOSITORY_JOBS = Symbol('REPOSITORY_JOBS');

/** The background Git operations on a Repository. */
export type RepositoryOperation = 'clone' | 'fetch';

/**
 * Schedules the background Git operation of a Project's Repository on the platform job
 * queue. The Repository row is the record of the attempt: its state (`connecting` for a
 * clone, `fetching` for a fetch) says what the job does, and the job carries the project id
 * only. Clones and fetches share one job per Repository, so at most one of them is waiting
 * or running at a time.
 */
export interface RepositoryJobs {
  /**
   * Schedules the operation and returns at once; `operation` sets its time limit.
   * @throws JobAlreadyActiveError (platform/queue) if an operation of the project is still
   * waiting or running.
   * @throws QueueUnavailableError (platform/queue) if the queue cannot be reached.
   */
  start(projectId: string, operation: RepositoryOperation): Promise<void>;

  /**
   * Cancels the project's operation, waiting or running, and returns once it has settled
   * (its last write, if any, is done and its job id is free for a new operation). A no-op
   * when nothing is scheduled.
   * @throws JobStillRunningError (platform/queue) if a running operation did not stop in time.
   * @throws QueueUnavailableError (platform/queue) if the queue cannot be reached.
   */
  cancel(projectId: string): Promise<void>;
}
