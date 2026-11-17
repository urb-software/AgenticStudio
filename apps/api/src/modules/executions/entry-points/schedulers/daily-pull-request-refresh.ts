import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { RequestDailyPullRequestRefreshesHandler } from '../../application/features/request-daily-pull-request-refreshes/handler.js';

/** DI token of the {@link DailyPullRequestRefreshSettings}. */
export const DAILY_PULL_REQUEST_REFRESH_SETTINGS = Symbol('DAILY_PULL_REQUEST_REFRESH_SETTINGS');

/**
 * When the daily pull request refresh runs (Issue #142). Production: every `intervalMs` from the
 * start. A test passes `manual`, which is handed the pass instead of a timer, so it runs the
 * refresh exactly when it wants to.
 */
export interface DailyPullRequestRefreshSettings {
  intervalMs: number;
  manual?: (pass: () => Promise<void>) => void;
}

/** How often the daily refresh looks for states older than a day. */
export const DAILY_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** The first pass after the app has started waits this long (it is not part of start-up). */
export const DAILY_REFRESH_FIRST_PASS_MS = 60 * 1000;

/**
 * Runs the daily refresh a minute after the app has started, and then every hour (it only takes
 * states older than a day, so each Run is asked about about once a day, and an API that was down
 * catches up soon after it starts). The timer is `unref`'d and cleared on shutdown; a failed
 * pass is logged and tried again at the next tick.
 */
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

  /** One pass (also called by tests); never throws. */
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
