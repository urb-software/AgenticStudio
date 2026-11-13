/**
 * Platform-only view of the queue's Redis for the health endpoint. Business modules use
 * the {@link JobQueues} port instead.
 */
export abstract class QueueHealth {
  /** True if the queue's Redis answers promptly. */
  abstract isAvailable(): Promise<boolean>;
}
