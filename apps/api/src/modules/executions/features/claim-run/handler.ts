import { Inject, Injectable } from '@nestjs/common';
import { resumeAnswer, type Run, type RunFailure } from '../../domain/entities/run.js';
import {
  RUN_LOG_REPOSITORY,
  type RunLogRepository,
} from '../../domain/repositories/run-log-repository.js';
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

const NOT_DELIVERABLE: RunFailure = {
  code: 'delivery_failed',
  detail:
    'The run cannot be delivered: it has no repository remote, integration branch or recorded ' +
    'Run branch.',
};

/** A resume with nothing recorded to resume in (Issue #103). */
const NOT_RESUMABLE: RunFailure = {
  code: 'preparation_failed',
  detail:
    'Working copy no longer exists — run again: Studio has no recorded Working copy, repository ' +
    'remote or integration branch for this run.',
};

/**
 * A claimed Run with what its payload needs besides the Run: how many Run steps it has taken
 * and the seq of its next event (Issue #103: a resumed step continues after the stored log).
 */
export interface ClaimedRun extends Run {
  completedSteps: number;
  nextSeq: number;
}

/**
 * Command (Issue #96): an agent worker asks for work. Lost workers are swept first (their
 * Runs fail and free their places), Runs waiting too long are cancelled and steps far past
 * their time limit time out (Issue #100); then the oldest eligible queued Run is handed out
 * under the concurrency limits; `null` when there is none. A `failed` Run whose delivery retry
 * was requested is handed out too, for the delivery only (Issue #102), and an answered Run, to
 * resume its agent session, only to the worker that started it (Issue #103).
 */
@Injectable()
export class ClaimRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_LOG_REPOSITORY) private readonly logs: RunLogRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
  ) {}

  async execute(workerId: string): Promise<ClaimedRun | null> {
    const now = this.clock.now();
    await failLostWorkers(this.runs, now, this.lease.seconds);
    // A Run left waiting too long holds a slot; it is cancelled first (Issue #100).
    await cancelLongWaitingRuns(this.runs, now);
    // A step far past its time limit holds a slot too (review of #121: Studio's backstop).
    await timeOutOverdueSteps(this.runs, now);
    for (;;) {
      const run = await this.runs.claimNext(workerId, now);
      // A Run from before Issue #98 whose project had no Repository has no remote to prepare
      // from (nor an integration branch, Issue #102): it fails with preparation_failed here
      // instead of reaching a worker (review S6).
      if (!run) return null;
      const reachable = run.remoteUrl !== '' && run.integrationBranch !== '';
      if (run.state === 'failed') {
        // A delivery retry (Issue #102): without a remote, an integration branch or a recorded
        // Run branch there is nothing to deliver; it fails again at once and is released
        // (review R5 of #122).
        if (reachable && run.workingCopy) return { ...run, completedSteps: 1, nextSeq: 1 };
        await this.runs.finishDeliveryRetry({
          runId: run.id,
          workerId,
          result: { state: 'failed', failure: NOT_DELIVERABLE },
          workingCopy: null,
          now,
        });
        continue;
      }
      if (resumeAnswer(run) !== null) {
        // Issue #103: the resumed step continues the Run's step numbers and its log's seqs.
        if (reachable && run.workingCopy) {
          const [steps, lastSeq] = await Promise.all([
            this.runs.listSteps(run.id),
            this.logs.lastSeq(run.id),
          ]);
          return { ...run, completedSteps: steps.length, nextSeq: lastSeq + 1 };
        }
        await this.failClaimed(run, workerId, NOT_RESUMABLE, now);
        continue;
      }
      if (reachable) return { ...run, completedSteps: 0, nextSeq: 1 };
      await this.failClaimed(run, workerId, NO_REMOTE, now);
    }
  }

  /** Fails a Run just claimed (`preparing`) before it reaches the worker. */
  private async failClaimed(run: Run, workerId: string, failure: RunFailure, now: Date) {
    await this.runs.transitionClaimed({
      runId: run.id,
      workerId,
      from: 'preparing',
      to: 'failed',
      failure,
      cancelRequested: false,
      now,
    });
  }
}
