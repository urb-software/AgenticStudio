import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { ResumeDisconnectsHandler } from '../../application/features/resume-disconnects/handler.js';

export const REPOSITORY_DISCONNECTS_SETTINGS = Symbol('REPOSITORY_DISCONNECTS_SETTINGS');

export interface RepositoryDisconnectsSettings {
  enabled: boolean;
  intervalMs: number;
}

/** Retries the cleanup of every `disconnecting` Repository at the interval of its settings. */
@Injectable()
export class RepositoryDisconnectsScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('RepositoryDisconnects');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly resume: ResumeDisconnectsHandler,
    @Inject(REPOSITORY_DISCONNECTS_SETTINGS)
    private readonly settings: RepositoryDisconnectsSettings,
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
    if (this.running) return;
    this.running = true;
    try {
      await this.resume.execute();
    } catch (error) {
      this.logger.error(
        'Resuming the disconnects failed; it runs again at the next interval.',
        redactSecrets(error instanceof Error ? error.message : String(error)),
      );
    } finally {
      this.running = false;
    }
  }
}
