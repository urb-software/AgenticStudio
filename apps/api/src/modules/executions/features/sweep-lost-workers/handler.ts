import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { goneWorkerRule } from '../../domain/entities/run.js';
import { RUN_REPOSITORY, type RunRepository } from '../../domain/repositories/run-repository.js';
import { failLostWorkers } from '../../domain/services/lost-workers.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';
import { ReleaseEnvironmentFileSnapshotsHandler } from '../release-environment-file-snapshots/handler.js';

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
  ) {
    this.since = clock.now();
  }

  /** When this handler started: a worker that never reported since counts from here. */
  private readonly since: Date;

  /** Returns how many Runs failed (also requested delivery retries whose worker is gone). */
  async execute(): Promise<number> {
    const now = this.clock.now();
    const lost = await failLostWorkers(this.runs, now, this.lease.seconds);
    return lost + (await this.abandonRetriesOfGoneWorkers(now));
  }

  /**
   * A requested delivery retry is handed only to the worker that started the Run (#102); when
   * that worker is gone for longer than the lease, the retry fails as "Working copy no longer
   * exists (agent worker gone)" and is released (review N2 of #122).
   */
  private async abandonRetriesOfGoneWorkers(now: Date): Promise<number> {
    const { seenBefore, failure } = goneWorkerRule(now, this.lease.seconds);
    let abandoned = 0;
    for (const retry of await this.runs.listPendingDeliveryRetries()) {
      const seen =
        (retry.startedBy ? this.statuses.lastSeen(retry.startedBy) : undefined) ?? this.since;
      if (seen < seenBefore && (await this.runs.abandonDeliveryRetry(retry.runId, failure, now))) {
        abandoned++;
      }
    }
    return abandoned;
  }
}

/** Longest pause between two sweeps; shorter leases sweep at half the lease. */
const MAX_SWEEP_INTERVAL_MS = 30_000;

/**
 * Runs the sweep on an interval once the app has started, so a lost worker is noticed even
 * when no other worker claims, and releases the Environment file snapshots of final Runs
 * (Issue #104). The timer is `unref`'d (it never keeps the process alive) and
 * cleared on shutdown; a failed sweep is logged and retried at the next tick.
 */
@Injectable()
export class LostWorkerSweepSchedule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('LostWorkerSweep');
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor(
    private readonly sweep: SweepLostWorkersHandler,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
    private readonly snapshots: ReleaseEnvironmentFileSnapshotsHandler,
  ) {}

  onApplicationBootstrap(): void {
    const intervalMs = Math.min(MAX_SWEEP_INTERVAL_MS, (this.lease.seconds * 1000) / 2);
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const failed = await this.sweep.execute();
      if (failed > 0) this.logger.warn(`${failed} run(s) failed: their agent worker was lost.`);
      // Environment file snapshots of Runs that ended any way (Issue #104); never throws.
      await this.snapshots.releaseFinal();
    } catch (error) {
      this.logger.error(
        'The lost-worker sweep failed; it runs again at the next interval.',
        redactSecrets(error instanceof Error ? error.message : String(error)),
      );
    } finally {
      this.sweeping = false;
    }
  }
}
