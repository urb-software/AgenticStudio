import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { RUN_REPOSITORY, type RunRepository } from '../../domain/repositories/run-repository.js';
import { failLostWorkers } from '../../domain/services/lost-workers.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
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
  ) {}

  /** Returns how many Runs failed. */
  async execute(): Promise<number> {
    return failLostWorkers(this.runs, this.clock.now(), this.lease.seconds);
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
