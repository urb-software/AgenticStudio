import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { DAILY_REFRESH_AGE_HOURS, DAILY_REFRESH_BATCH } from '../../domain/entities/run-lookup.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../domain/repositories/run-lookup-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import {
  PULL_REQUEST_REFRESH_SETTINGS,
  type PullRequestRefreshSettings,
} from '../../ports/pull-request-refresh-settings.js';

/**
 * Command (Issue #142): the daily refresh. Records a pull request lookup for every Run that has a
 * pull request which is draft, open or of unknown state and was last read more than a day ago (or
 * never), so a pull request merged or closed on GitHub is noticed even if nobody opens its Run.
 * It only records requests: an agent worker carries them out with read access through the Agent
 * account, and no agent CLI is started. A merged, closed or missing pull request is not asked
 * about again here; the Run page's own refresh finds it if it is reopened. Returns how many
 * requests it recorded.
 */
@Injectable()
export class RequestDailyPullRequestRefreshesHandler {
  constructor(
    @Inject(RUN_LOOKUP_REPOSITORY) private readonly lookups: RunLookupRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(): Promise<number> {
    const now = this.clock.now();
    const staleBefore = new Date(now.getTime() - DAILY_REFRESH_AGE_HOURS * 60 * 60 * 1000);
    let requested = 0;
    for (const runId of await this.lookups.listDueForDailyRefresh(
      staleBefore,
      DAILY_REFRESH_BATCH,
    )) {
      if ((await this.lookups.request(runId, 'pull_request_state', now)) === 'requested') {
        requested++;
      }
    }
    return requested;
  }
}

/** How often the daily refresh looks for states older than a day. */
export const DAILY_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Runs the daily refresh once the app has started, and then every hour (it only takes states
 * older than a day, so each Run is asked about about once a day, and an API that was down catches
 * up when it starts). The timer is `unref`'d and cleared on shutdown; a failed pass is logged and
 * tried again at the next tick.
 */
@Injectable()
export class DailyPullRequestRefreshSchedule
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('PullRequestRefresh');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly daily: RequestDailyPullRequestRefreshesHandler,
    @Inject(PULL_REQUEST_REFRESH_SETTINGS) private readonly settings: PullRequestRefreshSettings,
  ) {}

  onApplicationBootstrap(): void {
    if (this.settings.manual) {
      this.settings.manual(() => this.tick());
      return;
    }
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.settings.intervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass (also called by tests); never throws. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const requested = await this.daily.execute();
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
