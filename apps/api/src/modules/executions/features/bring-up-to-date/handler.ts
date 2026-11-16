import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  followUpEligibility,
  type FollowUpEligibility,
  FollowUpNotAllowedError,
  isRunId,
  type Run,
} from '../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../domain/repositories/run-repository.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../domain/repositories/run-lookup-repository.js';
import { followUpContext, runView } from '../../domain/services/follow-up-context.js';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

/**
 * Command (Issue #147): the operator asks for a finished Run's branch to be brought up to date
 * with the integration branch. It is a Follow-up in every respect (the same eligibility, the same
 * Run step allowance and concurrency limits, the same agent session and Working copy), marked
 * `bring_up_to_date`; its text is the operator's optional note. The agent worker that holds the
 * Working copy fetches the integration branch and merges it (never a rebase, never a force
 * push), then resumes the agent. The request does not look at how far behind the Run is: the
 * pull request state may be stale, so the worker decides, and says so when there was nothing to
 * do. Returns the queued Run and its eligibility now. Throws {@link RunNotFoundError} or
 * {@link FollowUpNotAllowedError}.
 */
@Injectable()
export class BringUpToDateHandler {
  private readonly logger = new Logger('BringUpToDate');

  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_STATUS_STORE) private readonly workers: WorkerStatusStore,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
    @Inject(RUN_LOOKUP_REPOSITORY) private readonly lookups: RunLookupRepository,
  ) {}

  async execute(
    runId: string,
    note: string | undefined,
  ): Promise<{ run: Run; followUp: FollowUpEligibility; workerConnected: boolean }> {
    const run = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!run) throw new RunNotFoundError();
    const before = this.eligibility(run);
    if (!before.allowed) throw new FollowUpNotAllowedError(before.reason);
    const queued = await this.runs.queueFollowUp(
      run.id,
      note ?? '',
      this.clock.now(),
      'bring_up_to_date',
    );
    if (queued) {
      // As with every Follow-up (Issue #142): the pull request state is read again; the worker
      // reads it before it starts anything, too.
      await this.lookups
        .request(queued.id, 'pull_request_state', this.clock.now())
        .catch((error: unknown) => {
          this.logger.warn(
            `Asking for the pull request state of run ${queued.id} failed: ${redactSecrets(
              error instanceof Error ? error.message : String(error),
            )}`,
          );
        });
      const refreshed = (await this.runs.findById(queued.id)) ?? queued;
      return runView(refreshed, this.workers, this.clock.now(), this.lease.seconds);
    }
    // The Run changed in between (a second submission, a claim): report why, as it is now.
    const current = await this.runs.findById(run.id);
    const after = current ? this.eligibility(current) : before;
    throw new FollowUpNotAllowedError(after.allowed ? 'not_finished' : after.reason);
  }

  private eligibility(run: Run): FollowUpEligibility {
    return followUpEligibility(
      run,
      followUpContext(run, this.workers, this.clock.now(), this.lease.seconds),
    );
  }
}
