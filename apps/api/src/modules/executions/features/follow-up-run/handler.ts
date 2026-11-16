import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  followUpEligibility,
  type FollowUpEligibility,
  FollowUpNotAllowedError,
  type FollowUpSource,
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
 * Command (Issue #141): the operator sends a Follow-up to a finished Run. When the Run can take
 * one ({@link followUpEligibility}), the text is stored in its conversation and the Run goes
 * back to `queued`; the agent worker that holds its Working copy then claims it, under the
 * concurrency limits, and resumes the same agent session with the Follow-up as the next Run
 * step. The store re-checks the conditions under a row lock, so a second submission is refused.
 * The text is the operator's input: stored as given (the endpoint trims and bounds it), with its
 * `source` when it was prepared from failing checks (Issue #145: the prepared draft is then
 * removed in the same step). Returns
 * the queued Run and its eligibility now. Throws {@link RunNotFoundError} or
 * {@link FollowUpNotAllowedError}.
 */
@Injectable()
export class FollowUpRunHandler {
  private readonly logger = new Logger('FollowUpRun');

  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_STATUS_STORE) private readonly workers: WorkerStatusStore,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
    @Inject(RUN_LOOKUP_REPOSITORY) private readonly lookups: RunLookupRepository,
  ) {}

  async execute(
    runId: string,
    text: string,
    source?: FollowUpSource,
  ): Promise<{ run: Run; followUp: FollowUpEligibility; workerConnected: boolean }> {
    const run = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!run) throw new RunNotFoundError();
    const before = this.eligibility(run);
    if (!before.allowed) throw new FollowUpNotAllowedError(before.reason);
    const queued = await this.runs.queueFollowUp(run.id, text, this.clock.now(), source);
    if (queued) {
      // Issue #142: the pull request state is read again with every Follow-up (the agent worker
      // also checks it before it starts the agent); the page then shows the state it found.
      await this.lookups
        .request(queued.id, 'pull_request_state', this.clock.now())
        .catch((error: unknown) => {
          // The Follow-up is accepted anyway; the worker reads the state again before it starts.
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
