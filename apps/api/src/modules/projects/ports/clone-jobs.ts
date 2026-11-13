/** DI token for the {@link CloneJobs} port. */
export const CLONE_JOBS = Symbol('CLONE_JOBS');

/**
 * Schedules the background clone of a Project's Repository (the `clone-repository`
 * feature, on the platform job queue). The Repository row in state `connecting` is the
 * record of the attempt; the job carries the project id only.
 */
export interface CloneJobs {
  /**
   * Schedules the clone and returns at once.
   * @throws JobAlreadyActiveError (platform/queue) if a clone of the project is still
   * waiting or running.
   * @throws QueueUnavailableError (platform/queue) if the queue cannot be reached.
   */
  start(projectId: string): Promise<void>;
}
