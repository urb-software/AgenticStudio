import { Inject, Injectable } from '@nestjs/common';
import type { Run, RunFailure } from '../../domain/entities/run.js';
import { RUN_REPOSITORY, type RunRepository } from '../../domain/repositories/run-repository.js';
import { failLostWorkers } from '../../domain/services/lost-workers.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';

const NO_REMOTE: RunFailure = {
  code: 'preparation_failed',
  detail:
    "The run has no repository remote to prepare from (the project's repository was removed).",
};

/**
 * Command (Issue #96): an agent worker asks for work. Lost workers are swept first (their
 * Runs fail and free their places), then the oldest eligible queued Run is handed out under
 * the concurrency limits; `null` when there is none. A `failed` Run whose delivery retry was
 * requested is handed out too, for the delivery only (Issue #102).
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
    for (;;) {
      const run = await this.runs.claimNext(workerId, now);
      // A Run from before Issue #98 whose project had no Repository has no remote to prepare
      // from (nor an integration branch, Issue #102): it fails with preparation_failed here
      // instead of reaching a worker (review S6).
      if (!run || (run.remoteUrl !== '' && run.integrationBranch !== '')) return run;
      await this.runs.transitionClaimed({
        runId: run.id,
        workerId,
        from: 'preparing',
        to: 'failed',
        failure: NO_REMOTE,
        now,
      });
    }
  }
}
