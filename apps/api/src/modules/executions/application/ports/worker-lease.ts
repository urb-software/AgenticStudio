export const WORKER_LEASE = Symbol('WORKER_LEASE');

export interface WorkerLease {
  seconds: number;
}
