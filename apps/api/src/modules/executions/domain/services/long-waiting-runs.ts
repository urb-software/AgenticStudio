import { longWaitCancellation } from '../entities/run.js';
import type { RunRepository } from '../repositories/run-repository.js';

/**
 * The long-wait sweep (Issue #100), the one place it is written: every Run waiting for the
 * operator longer than its own `waitingDays` → `cancelled` by the system, with that stated as
 * the reason. The interval sweep and every claim use it (a waiting Run holds a slot). Returns
 * how many Runs were cancelled.
 */
export async function cancelLongWaitingRuns(runs: RunRepository, now: Date): Promise<number> {
  let cancelled = 0;
  for (const run of await runs.listWaiting()) {
    const cancellation = longWaitCancellation(run, now);
    if (!cancellation) continue;
    // Conditional: an answer or an operator's cancel in between wins.
    if (await runs.cancelUnheld(run.id, 'waiting_for_operator', cancellation, now)) cancelled++;
  }
  return cancelled;
}
