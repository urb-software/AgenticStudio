import { Inject, Injectable } from '@nestjs/common';
import { lostWorkerRule, type Run } from '../../domain/entities/run.js';
import { RUN_REPOSITORY, type RunRepository } from '../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';

/**
 * Command (Issue #96): an agent worker asks for work. Lost workers are swept first (their
 * Runs fail and free their places), then the oldest eligible queued Run is handed out under
 * the concurrency limits; `null` when there is none.
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
    const { staleBefore, failure } = lostWorkerRule(now, this.lease.seconds);
    await this.runs.failStaleClaims(staleBefore, failure, now);
    return this.runs.claimNext(workerId, now);
  }
}
