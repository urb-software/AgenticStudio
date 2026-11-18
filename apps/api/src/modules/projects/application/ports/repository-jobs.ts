export const REPOSITORY_JOBS = Symbol('REPOSITORY_JOBS');

export type RepositoryOperation = 'clone' | 'fetch';

/**
 * Schedules the background Git operation of a Repository on the job queue. The job carries only
 * the project id; clones and fetches share one job, so at most one is waiting or running.
 */
export interface RepositoryJobs {
  /**
   * Schedules the operation and returns at once; `operation` sets its time limit.
   * @throws JobAlreadyActiveError (platform/queue) if one is still waiting or running.
   * @throws QueueUnavailableError (platform/queue) if the queue cannot be reached.
   */
  start(projectId: string, operation: RepositoryOperation): Promise<void>;

  /**
   * Cancels the project's operation and returns once it has settled; a no-op when none.
   * @throws JobStillRunningError (platform/queue) if it did not stop in time.
   * @throws QueueUnavailableError (platform/queue) if the queue cannot be reached.
   */
  cancel(projectId: string): Promise<void>;
}
