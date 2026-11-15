import { Inject, Injectable } from '@nestjs/common';
import type { Run, RunFailure } from '../../domain/entities/run.js';
import { RUN_REPOSITORY, type RunRepository } from '../../domain/repositories/run-repository.js';
import { cancelLongWaitingRuns } from '../../domain/services/long-waiting-runs.js';
import { failLostWorkers } from '../../domain/services/lost-workers.js';
import { timeOutOverdueSteps } from '../../domain/services/overdue-steps.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';

const NO_REMOTE: RunFailure = {
  code: 'preparation_failed',
  detail:
    "The run has no repository remote to prepare from (the project's repository was removed).",
};

/**
 * Command (Issue #96): an agent worker asks for work. Lost workers are swept first (their
 * Runs fail and free their places) and Runs waiting too long are cancelled (Issue #100); then
 * the oldest eligible queued Run is handed out under the concurrency limits; `null` when
 * there is none.
 */
@Injectable()
export class ClaimRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
  ) {}

  async execute(workerId: string): Promise<Run | null> {
    const now = this.clock.now();
    await failLostWorkers(this.runs, now, this.lease.seconds);
    // A Run left waiting too long holds a slot; it is cancelled first (Issue #100).
    await cancelLongWaitingRuns(this.runs, now);
    // A step far past its time limit holds a slot too (review of #121: Studio's backstop).
    await timeOutOverdueSteps(this.runs, now);
    for (;;) {
      const run = await this.runs.claimNext(workerId, now);
      // A Run from before Issue #98 whose project had no Repository has no remote to prepare
      // from: it fails with preparation_failed here instead of reaching a worker (review S6).
      if (!run || run.remoteUrl !== '') return run;
      await this.runs.transitionClaimed({
        runId: run.id,
        workerId,
        from: 'preparing',
        to: 'failed',
        failure: NO_REMOTE,
        cancelRequested: false,
        now,
      });
    }
  }
}
