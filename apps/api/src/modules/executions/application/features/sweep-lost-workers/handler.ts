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
  /**
   * How many Runs failed (also requested delivery retries and answered Runs whose worker is
   * gone).
   */
  failed: number;
}

/**
 * Command (Issue #96): every held Run (`preparing` or `running`) whose last heartbeat is
 * older than the lease → `failed` with `worker_lost`. Runs waiting for the operator are not
 * held by any worker and never swept. Also run before every claim (`claim-run`).
 */
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

  /** When this handler started: a worker that never reported since counts from here. */
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

  /**
   * An answered Run is resumed only by the worker that started it (#103): it alone has the
   * Working copy and the agent's session. When that worker is gone for longer than the lease,
   * the Run fails as "Working copy no longer exists (agent worker gone) — run again".
   */
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
        // Final: its log takes no more events, so nothing more to redact (Issue #104).
        await this.snapshots.releaseFor(resume.runId);
      }
    }
    return abandoned;
  }

  /**
   * A requested delivery retry is handed only to the worker that started the Run (#102); when
   * that worker is gone for longer than the lease, the retry fails as "Working copy no longer
   * exists (agent worker gone)" and is released (review N2 of #122).
   */
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
        // The Working copy is gone with its worker: nothing more to redact (Issue #104).
        await this.snapshots.releaseFor(retry.runId);
      }
    }
    return abandoned;
  }
}
