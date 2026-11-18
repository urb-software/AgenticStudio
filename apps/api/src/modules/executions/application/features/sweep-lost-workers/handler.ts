import { Inject, Injectable } from '@nestjs/common';
import { GoneWorkerRule, LostWorkerRule } from '../../../domain/value-objects/run-sweep-rules.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import {
  ENVIRONMENT_FILE_SNAPSHOTS,
  type EnvironmentFileSnapshots,
} from '../../ports/environment-file-snapshots.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

export interface SweepLostWorkersResult {
  failed: number;
}

/** Runs waiting for the operator are not held by any worker and never swept. */
@Injectable()
export class SweepLostWorkersHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
    @Inject(WORKER_STATUS_STORE) private readonly statuses: WorkerStatusStore,
    @Inject(ENVIRONMENT_FILE_SNAPSHOTS) private readonly snapshots: EnvironmentFileSnapshots,
  ) {
    this.since = clock.now();
  }

  // The status store starts empty after a restart: a worker not seen yet gets one lease counted
  // from here.
  private readonly since: Date;

  async execute(): Promise<SweepLostWorkersResult> {
    const now = this.clock.now();
    const rule = LostWorkerRule.at(now, this.lease.seconds);
    const lost = await this.runs.failStaleClaims(
      rule.staleBefore,
      rule.failure,
      rule.deliveryFailure,
      now,
    );
    return {
      failed:
        lost +
        (await this.abandonRetriesOfGoneWorkers(now)) +
        (await this.abandonResumesOfGoneWorkers(now)),
    };
  }

  // Only the worker that started an answered Run has its Working copy and agent session.
  private async abandonResumesOfGoneWorkers(now: Date): Promise<number> {
    const rule = GoneWorkerRule.at(now, this.lease.seconds);
    let abandoned = 0;
    for (const resume of await this.runs.listPendingResumes()) {
      const seen =
        (resume.startedBy ? this.statuses.lastSeen(resume.startedBy) : undefined) ?? this.since;
      if (
        rule.isGone(seen) &&
        (await this.runs.abandonResume(resume.runId, rule.resumeFailure, now))
      ) {
        abandoned++;
        await this.snapshots.releaseFor(resume.runId);
      }
    }
    return abandoned;
  }

  // Only the worker that started the Run has the Working copy a delivery retry needs.
  private async abandonRetriesOfGoneWorkers(now: Date): Promise<number> {
    const rule = GoneWorkerRule.at(now, this.lease.seconds);
    let abandoned = 0;
    for (const retry of await this.runs.listPendingDeliveryRetries()) {
      const seen =
        (retry.startedBy ? this.statuses.lastSeen(retry.startedBy) : undefined) ?? this.since;
      if (
        rule.isGone(seen) &&
        (await this.runs.abandonDeliveryRetry(retry.runId, rule.deliveryRetryFailure, now))
      ) {
        abandoned++;
        await this.snapshots.releaseFor(retry.runId);
      }
    }
    return abandoned;
  }
}
