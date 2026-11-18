import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { CancelLongWaitingRunsHandler } from '../../application/features/cancel-long-waiting-runs/handler.js';
import { ReleaseFinalSnapshotsHandler } from '../../application/features/release-final-snapshots/handler.js';
import { RenewHeldRunLeasesHandler } from '../../application/features/renew-held-run-leases/handler.js';
import { SweepLostWorkersHandler } from '../../application/features/sweep-lost-workers/handler.js';
import { TimeOutOverdueStepsHandler } from '../../application/features/time-out-overdue-steps/handler.js';

export const RUN_SWEEPS_SETTINGS = Symbol('RUN_SWEEPS_SETTINGS');

export interface RunSweepsSettings {
  intervalMs: number;
}

@Injectable()
export class RunSweepsScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('RunSweeps');
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor(
    private readonly lostWorkers: SweepLostWorkersHandler,
    private readonly overdueSteps: TimeOutOverdueStepsHandler,
    private readonly longWaits: CancelLongWaitingRunsHandler,
    private readonly leases: RenewHeldRunLeasesHandler,
    private readonly snapshots: ReleaseFinalSnapshotsHandler,
    @Inject(RUN_SWEEPS_SETTINGS) private readonly settings: RunSweepsSettings,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const { renewed } = await this.leases.execute();
      if (renewed === null) {
        this.logger.warn(
          'Not renewing the leases of held runs: they were renewed less than a lease ago ' +
            '(is the API restarting repeatedly?).',
        );
      } else if (renewed > 0) {
        this.logger.log(`Renewed the lease of ${renewed} held run(s) at start.`);
      }
    } catch (error) {
      // Not fatal: the sweep still runs; at worst a Run whose worker kept
      // going fails as worker_lost.
      this.logger.warn(
        `Renewing the leases of held runs at start failed: ${redactSecrets(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    }
    this.timer = setInterval(() => void this.tick(), this.settings.intervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const { failed } = await this.lostWorkers.execute();
      if (failed > 0) this.logger.warn(`${failed} run(s) failed: their agent worker was lost.`);
      const { timedOut } = await this.overdueSteps.execute();
      if (timedOut > 0) {
        this.logger.warn(`${timedOut} run(s) timed out: their run step ran far past its limit.`);
      }
      const { cancelled } = await this.longWaits.execute();
      if (cancelled > 0) {
        this.logger.warn(`${cancelled} run(s) cancelled: they waited too long for the operator.`);
      }
      await this.snapshots.execute();
    } catch (error) {
      this.logger.error(
        'A run sweep failed; it runs again at the next interval.',
        redactSecrets(error instanceof Error ? error.message : String(error)),
      );
    } finally {
      this.sweeping = false;
    }
  }
}
