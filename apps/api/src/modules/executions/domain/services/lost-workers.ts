import { lostWorkerRule } from '../entities/run.js';
import type { RunRepository } from '../repositories/run-repository.js';

/**
 * The lost-worker sweep (Issue #96), the one place it is written: every held Run whose last
 * heartbeat is older than the lease → `failed` with `worker_lost`. The interval sweep and every
 * claim use it. Returns how many Runs failed.
 */
export function failLostWorkers(
  runs: RunRepository,
  now: Date,
  leaseSeconds: number,
): Promise<number> {
  const { staleBefore, failure, deliveryFailure } = lostWorkerRule(now, leaseSeconds);
  return runs.failStaleClaims(staleBefore, failure, deliveryFailure, now);
}
