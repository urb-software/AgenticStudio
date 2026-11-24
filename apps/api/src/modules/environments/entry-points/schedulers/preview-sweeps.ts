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
  intervalMs: number;
}

/** The longest pause between sweeps, in milliseconds. */
const MAX_INTERVAL_MS = 30_000;

/** The pause between sweeps: 30 seconds, or half the lease when that is shorter. */
export function previewSweepIntervalMs(leaseSeconds: number): number {
  return Math.min(MAX_INTERVAL_MS, (leaseSeconds * 1000) / 2);
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
      const { releasedSnapshots, unclaimed } = await this.sweep.execute();
      if (releasedSnapshots > 0) {
        this.logger.warn(`${releasedSnapshots} Preview operation(s) failed that nobody carried.`);
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
