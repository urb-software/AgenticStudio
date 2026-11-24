import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { ReleaseMergeRebuildsHandler } from '../../application/features/release-merge-rebuilds/handler.js';

export const PREVIEW_MERGE_REBUILDS_SETTINGS = Symbol('PREVIEW_MERGE_REBUILDS_SETTINGS');

export interface PreviewMergeRebuildsSettings {
  enabled: boolean;
  intervalMs: number;
}

/** Carries out the rebuilds merges recorded at the interval of its settings; it never records one. */
@Injectable()
export class PreviewMergeRebuildsScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('PreviewMergeRebuilds');
  private timer: NodeJS.Timeout | undefined;
  private releasing = false;

  constructor(
    private readonly release: ReleaseMergeRebuildsHandler,
    @Inject(PREVIEW_MERGE_REBUILDS_SETTINGS)
    private readonly settings: PreviewMergeRebuildsSettings,
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
    if (this.releasing) return;
    this.releasing = true;
    try {
      const { built, failed } = await this.release.execute();
      if (built > 0) this.logger.log(`${built} Preview rebuild(s) started after a merge.`);
      if (failed > 0) this.logger.warn(`${failed} Preview rebuild(s) after a merge failed.`);
    } catch (error) {
      this.logger.error(
        'Releasing the Preview rebuilds failed; it runs again at the next interval.',
        redactSecrets(error instanceof Error ? error.message : String(error)),
      );
    } finally {
      this.releasing = false;
    }
  }
}
