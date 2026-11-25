export const PUBLISH_LOCK = Symbol('PUBLISH_LOCK');

/** One publish at a time, across API processes. */
export interface PublishLock {
  /**
   * Runs `work` while holding the lock, or answers `ran: false` at once when another publish
   * holds it: it never waits. The lock is released when `work` ends, however it ends.
   */
  runExclusive<T>(work: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>;
}
