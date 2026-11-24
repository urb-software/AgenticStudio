import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { SweepPreviewOperationsHandler } from '../../application/features/sweep-preview-operations/handler.js';

export const PREVIEW_SWEEPS_SETTINGS = Symbol('PREVIEW_SWEEPS_SETTINGS');

export interface PreviewSweepsSettings {
  enabled: boolean;
  intervalMs: number;
}

/** Runs the Preview operation sweep at the interval of its settings. */
@Injectable()
export class PreviewSweepsScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('PreviewSweeps');
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor(
    private readonly sweep: SweepPreviewOperationsHandler,
    @Inject(PREVIEW_SWEEPS_SETTINGS) private readonly settings: PreviewSweepsSettings,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.settings.enabled) return;
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
      const { releasedSnapshots, unclaimed, stateChecks } = await this.sweep.execute();
      if (releasedSnapshots > 0) {
        this.logger.warn(`${releasedSnapshots} Preview operation(s) failed that nobody carried.`);
      }
      if (stateChecks > 0) {
        this.logger.warn(`${stateChecks} Preview state check(s) requested after a lost build.`);
      }
      if (unclaimed > 0) {
        this.logger.warn(`${unclaimed} Preview operation(s) failed: no controller took them.`);
      }
    } catch (error) {
      this.logger.error(
        'A Preview sweep failed; it runs again at the next interval.',
        redactSecrets(error instanceof Error ? error.message : String(error)),
      );
    } finally {
      this.sweeping = false;
    }
  }
}
