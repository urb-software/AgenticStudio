import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { RequestDailyPullRequestRefreshesHandler } from '../../application/features/request-daily-pull-request-refreshes/handler.js';

export const DAILY_PULL_REQUEST_REFRESH_SETTINGS = Symbol('DAILY_PULL_REQUEST_REFRESH_SETTINGS');

export interface DailyPullRequestRefreshSettings {
  intervalMs: number;
  manual?: (pass: () => Promise<void>) => void;
}

export const DAILY_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export const DAILY_REFRESH_FIRST_PASS_MS = 60 * 1000;

@Injectable()
export class DailyPullRequestRefreshScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('PullRequestRefresh');
  private timer: NodeJS.Timeout | undefined;
  private firstPass: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly daily: RequestDailyPullRequestRefreshesHandler,
    @Inject(DAILY_PULL_REQUEST_REFRESH_SETTINGS)
    private readonly settings: DailyPullRequestRefreshSettings,
  ) {}

  onApplicationBootstrap(): void {
    if (this.settings.manual) {
      this.settings.manual(() => this.tick());
      return;
    }
    this.firstPass = setTimeout(() => void this.tick(), DAILY_REFRESH_FIRST_PASS_MS);
    this.firstPass.unref();
    this.timer = setInterval(() => void this.tick(), this.settings.intervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearTimeout(this.firstPass);
    clearInterval(this.timer);
    this.firstPass = undefined;
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { requested } = await this.daily.execute();
      if (requested > 0) {
        this.logger.log(`Asked for the state of ${requested} pull request(s) to be read again.`);
      }
    } catch (error) {
      this.logger.error(
        'The daily pull request refresh failed; it runs again at the next interval.',
        redactSecrets(error instanceof Error ? error.message : String(error)),
      );
    } finally {
      this.running = false;
    }
  }
}
