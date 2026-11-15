/** DI token of the {@link WorkerLease} setting. */
export const WORKER_LEASE = Symbol('WORKER_LEASE');

/**
 * How long a claimed Run may go without a heartbeat before it fails with `worker_lost`
 * (`STUDIO_WORKER_LEASE_SECONDS`, default 60).
 */
export interface WorkerLease {
  seconds: number;
}
