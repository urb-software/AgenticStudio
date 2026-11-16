import {
  BRING_UP_TO_DATE_DEFAULT_TEXT,
  FAILURE_DETAIL_MAX_LENGTH,
  type Provider,
  type RunFailure,
  type RunPayload,
  type RunStepResult,
  runStepResultSchema,
  type WorkingCopyReport,
  type WorkerDisk,
  type WorkerStatusReport,
} from '@agentic-studio/contracts';
import { posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AGENT_DEFINITION } from './agent-definition/index.js';
import { bringUpToDateInstruction } from './agent-definition/bring-up-to-date.js';
import {
  type BranchUpdatePort,
  type BranchUpdateStart,
  MergeIncompleteError,
} from './branch-update.js';
import { DeliveryFailedError, type DeliveryPort } from './delivery.js';
import { ProviderDisabledError } from './provider-gate.js';
import type { LookupService } from './pull-request-lookups.js';
import { type Backoff, ReportOutbox } from './report-outbox.js';
import type { ComputedRunDiff, RunDiffPort, RunDiffReport } from './run-diff.js';
import { RunDiffUnavailableError } from './run-diff.js';
import { RunLog } from './run-log.js';
import { composeProjectName, STEP_PROCESSES_FILE } from './run-layout.js';
import type { RunResources } from './run-resources.js';
import { AgentFailedError, drainRunStep, type Runner, UsageLimitError } from './runner.js';
import { StepProcesses } from './step-processes.js';
import { isRunLost, type StudioApi } from './studio-api.js';
import { PreparationFailedError, type PreparedRun, type WorkingCopyPort } from './working-copy.js';

/** Where the worker writes what it does; never a token. */
export interface WorkerLogger {
  info(message: string): void;
  error(message: string): void;
}

/** The worker routes the loop uses ({@link StudioApi} in production). */
export type WorkerApi = Pick<
  StudioApi,
  | 'claim'
  | 'reportState'
  | 'reportStep'
  | 'heartbeat'
  | 'reportStatus'
  | 'appendEvents'
  | 'reportDiff'
>;

/** The process groups of one Run step ({@link StepProcesses} in production). */
export type StepProcessGroups = Pick<StepProcesses, 'register' | 'terminate' | 'release'>;

export interface AgentWorkerOptions {
  api: WorkerApi;
  runner: Runner;
  /**
   * The provider gate (Issue #101), checked before a Run's Working copy is prepared (note on
   * #117), so a Run for a switched-off provider fetches nothing. The runner dispatcher checks it
   * again before every Run step, and the spawn boundary before any CLI process.
   */
  gate: { assertEnabled(provider: Provider): void };
  /** Prepares and inspects each Run's Working copy (Issue #98). */
  workingCopies: WorkingCopyPort;
  /** Commits, pushes and opens the draft pull request of a `done` Run (Issue #102). */
  deliveries: DeliveryPort;
  /** Merges the integration branch into a Run branch when the operator asks (Issue #147). */
  branchUpdates: BranchUpdatePort;
  /** Computes the Run's diffs after every Run step that reports a result (Issue #144). */
  diffs: RunDiffPort;
  /** Removes a stopped Run's containers through its Compose project (Issue #100). */
  resources: RunResources;
  /**
   * Answers Studio's pull request lookups (Issue #142) in a loop of its own, whatever the worker
   * is carrying, and reads the pull request before a Follow-up starts. Without it the worker
   * serves no lookups and starts every Follow-up.
   */
  lookups?: LookupService;
  /**
   * Reported to Studio before every claim and with every heartbeat (Issue #101), so Studio
   * knows which providers this worker enables. Fixed for the life of the process.
   */
  status: WorkerStatusReport;
  /**
   * Issue #143: the latest disk figures, added to each status report (none until measured). The
   * monitor measures at most every ten minutes, so this is cheap to ask.
   */
  disk?: { snapshot(): WorkerDisk | undefined };
  /** Pause between two claims when there is no work, or after the API was unreachable. */
  pollMs: number;
  /** Interval of heartbeats while carrying a Run. */
  heartbeatMs: number;
  /** Grace between the interrupt and the kill of a stopped Run step's processes (Issue #100). */
  killGraceMs: number;
  logger: WorkerLogger;
  /** Test seam: the length of one minute of a Run step's time limit (default 60 000 ms). */
  minuteMs?: number;
  /** Test seam: the backoff of report deliveries while Studio is unreachable. */
  reportBackoff?: Backoff;
  /** Test seam: the process groups of a Run step (default: recorded in the Run's directory). */
  processesFor?: (prepared: PreparedRun) => StepProcessGroups;
}

/** Longest wait for the Working copy's state that goes with a failure report. */
const FAILURE_REPORT_TIMEOUT_MS = 30_000;

/** The failure reported for the Run being carried when the worker shuts down (Issue #96). */
export const SHUTDOWN_FAILURE: RunFailure = { code: 'worker_lost', detail: 'worker shut down' };

const UNEXPECTED_FAILURE: RunFailure = {
  code: 'unknown',
  detail: 'The runner stopped unexpectedly. The agent worker log has the details.',
};

/** How long a stopping worker still tries to deliver the Run's buffered log (Issue #99). */
const SHUTDOWN_LOG_DEADLINE_MS = 2000;

/**
 * How long the worker keeps trying to deliver a Run's log before its end report while Studio is
 * unreachable (Issue #100): the step's events are part of the buffered reports, so a Studio
 * outage drops none of them (only the worker's own buffer bound does, as in #99).
 */
const LOG_OUTAGE_DEADLINE_MS = 24 * 60 * 60 * 1000;

const INVALID_RESULT_FAILURE: RunFailure = {
  code: 'agent_failed',
  detail: "The agent's structured result was not valid.",
};

/** A delivery retry that stopped for a reason other than a {@link DeliveryFailedError}. */
const DELIVERY_SHUTDOWN_FAILURE: RunFailure = {
  code: 'delivery_failed',
  detail: 'The agent worker shut down during the delivery. Retry the delivery.',
};
const DELIVERY_UNEXPECTED_FAILURE: RunFailure = {
  code: 'delivery_failed',
  detail: 'The delivery stopped unexpectedly. The agent worker log has the details.',
};

/** Why a Run step was stopped before its end (Issue #100). */
export type StopReason = 'cancel' | 'timeout' | 'lost' | 'shutdown';

/** The abort reason of a stopped Run step. */
export class StepStoppedError extends Error {
  constructor(readonly reason: StopReason) {
    super(`run step stopped: ${reason}`);
    this.name = 'StepStoppedError';
  }
}

/** The next Run step would exceed the Run's maximum (Issue #100). */
export class StepLimitError extends Error {
  constructor(readonly maxSteps: number) {
    super(
      `The run reached its limit of ${maxSteps} run ${maxSteps === 1 ? 'step' : 'steps'}; ` +
        'no further step was started.',
    );
    this.name = 'StepLimitError';
  }
}

/**
 * The agent worker's loop (Issue #96): claim a Run, prepare its Working copy while the Run is
 * `preparing` (Issue #98), carry it out through the runner while sending heartbeats, commit
 * what a `done` step left, report its Run step result with the Working copy's state, deliver
 * it (Issue #102: push the Run branch, open the draft pull request) and report its final state,
 * repeat. The Run's events are forwarded to Studio as they happen (Issue #99). A claim of kind
 * `deliver` (a delivery retry) only delivers from the kept Working copy. It carries one Run at
 * a time.
 *
 * Issue #100: a Run step is stopped when the heartbeat answer carries the operator's cancel,
 * when it reaches its time limit, when Studio says the worker lost the Run, or when the worker
 * stops: the runner is aborted, the step's process groups get SIGINT, then SIGKILL after the
 * grace, and the Run's containers are removed (its Working copy is kept). The Run is then
 * reported `cancelled`, `timed_out`, nothing (lost), or `failed` with `worker_lost` ("worker
 * shut down"). A step that would exceed the Run's maximum is not started (`step_limit`). While
 * Studio is unreachable the step keeps going and its reports wait, in order, in an outbox. A
 * delivery starts only while no stop is pending; a stop or a crash during it leaves a delivery
 * to retry (`delivery_failed`), except an operator's cancel, which ends the Run `cancelled`.
 *
 * Issue #103: a claim of kind `resume` (the operator answered the agent's question) is carried
 * like a start, except that the kept Working copy is located instead of prepared and the runner
 * resumes the agent session Studio names with the answer, as the Run's next step: numbered after
 * the steps it took, its events after the seqs Studio stored. The provider gate and the step
 * limit are checked first, as for every step.
 *
 * Issue #144: after every step result the Run's diffs are computed from the Working copy and
 * reported right after the step report (or why they could not be computed); once a delivery
 * pushed the Run branch, they are reported again, saying their changes are pushed.
 */
export class AgentWorker {
  private stopping = false;
  /** Aborted by {@link stop}: wakes the idle pause and abandons in-flight calls. */
  private readonly shutdown = new AbortController();
  private stopCurrent: ((reason: StopReason) => void) | undefined;
  private currentRunId: string | undefined;
  /** Whether the Run being carried is in its delivery: then a failure is delivery_failed. */
  private delivering = false;
  private loop: Promise<void> | undefined;

  constructor(private readonly options: AgentWorkerOptions) {}

  /** The Run this worker carries right now, if any (retention never removes its directory). */
  get carrying(): string | undefined {
    return this.currentRunId;
  }

  /** Starts the loop (and the lookup loop, Issue #142); resolves when both have stopped. */
  run(): Promise<void> {
    this.loop ??= Promise.all([this.poll(), this.pollLookups()]).then(() => undefined);
    return this.loop;
  }

  /** Stops the loop and waits until the Run being carried (if any) is stopped and reported. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.shutdown.abort();
    this.stopCurrent?.('shutdown');
    await this.loop;
  }

  private async poll(): Promise<void> {
    const { api, logger, pollMs } = this.options;
    while (!this.stopping) {
      let run: RunPayload | null = null;
      await this.reportStatus();
      try {
        run = await api.claim(this.shutdown.signal);
      } catch (error) {
        logger.error(`Claiming a run failed: ${describe(error)}`);
      }
      if (run) {
        await this.carry(run);
      } else {
        await this.pause(pollMs);
      }
    }
  }

  /**
   * Issue #142: Studio's lookups (the state of a Run's pull request) are answered independently
   * of any Run this worker carries, so a long Run step does not hold them up. It starts no agent
   * and changes nothing on the Git host. A failed claim is logged and tried again after the pause.
   */
  private async pollLookups(): Promise<void> {
    const { lookups, logger, pollMs } = this.options;
    if (!lookups) return;
    while (!this.stopping) {
      let handled = 0;
      try {
        handled = await lookups.serve(this.shutdown.signal);
      } catch (error) {
        if (!this.stopping) logger.error(`Serving lookups failed: ${describe(error)}`);
      }
      if (handled === 0) await this.pause(pollMs);
    }
  }

  private async carry(run: RunPayload): Promise<void> {
    const { api, logger, heartbeatMs } = this.options;
    const abort = new AbortController();
    // A delivery is not interrupted by the operator's cancel (review of #121): it finishes, and
    // the cancelled Run records what it pushed. Losing the Run or stopping the worker still
    // interrupts it.
    const deliveryAbort = new AbortController();
    const stop = (reason: StopReason) => {
      if (reason !== 'cancel' && !deliveryAbort.signal.aborted) {
        deliveryAbort.abort(new StepStoppedError(reason));
      }
      if (!abort.signal.aborted) abort.abort(new StepStoppedError(reason));
    };
    this.stopCurrent = stop;
    this.currentRunId = run.runId;
    const outbox = new ReportOutbox({
      signal: this.shutdown.signal,
      backoff: this.options.reportBackoff,
      onLost: () => stop('lost'),
      logger,
    });
    let prepared: PreparedRun | undefined;
    let processes: StepProcessGroups | undefined;
    /** Whether the end of the Follow-up the Run works on was logged already (Issue #141). */
    let followUpMarked = false;
    /** Issue #147: the integration branch commit this part merges, and the Run branch's commit before. */
    let expectedCommit: string | undefined = run.updateTip;
    let baseCommit: string | undefined = run.updateBase;
    /** Issue #147: where the merge started, reported with `running`. */
    let mergeStarted: { baseCommit: string; integrationCommit: string } | undefined;
    /** Issue #147: what the agent is told after the merge started, in place of the note. */
    let instruction: string | undefined;
    logger.info(`Carrying run ${run.runId} (${run.provider}).`);
    // The Run's events go to Studio as they happen (Issue #99); a resumed Run's and a delivery
    // retry's continue after the seqs Studio stored (Issue #103).
    const log = new RunLog({
      api,
      runId: run.runId,
      logger,
      onLost: () => stop('lost'),
      firstSeq: run.nextSeq ?? 1,
    });
    // The Run step this claim carries out; a delivery retry starts none, and what it logs
    // belongs to the Run's last step.
    const stepIndex =
      run.kind === 'deliver' ? Math.max(run.completedSteps, 1) : run.completedSteps + 1;
    const heartbeats = setInterval(() => {
      // Keeps Studio's view of this worker fresh while it carries a long Run.
      void this.reportStatus();
      api.heartbeat(run.runId, this.shutdown.signal).then(
        (answer) => {
          if (answer.cancelRequested && !abort.signal.aborted) {
            logger.info(`Run ${run.runId}: the operator cancelled it.`);
            stop('cancel');
          }
        },
        (error: unknown) => {
          // A Studio outage is not a reason to stop: the step goes on (Issue #100).
          if (isRunLost(error)) stop('lost');
          logger.error(`Heartbeat for run ${run.runId} failed: ${describe(error)}`);
        },
      );
    }, heartbeatMs);
    heartbeats.unref();
    try {
      // A stop that arrived while the claim was in flight.
      if (this.stopping) stop('shutdown');
      abort.signal.throwIfAborted();
      if (run.kind === 'deliver') {
        await this.retryDelivery(run, abort.signal, outbox, (located) => (prepared = located));
        return;
      }
      // Before anything is fetched (note on #117); the dispatcher checks again before the step.
      this.options.gate.assertEnabled(run.provider);
      // Issue #141: each part of the Run (the first, or one Follow-up) gets its own allowance.
      if (run.completedSteps + 1 > (run.stepsBeforePart ?? 0) + run.limits.maxSteps) {
        throw new StepLimitError(run.limits.maxSteps);
      }
      // Issue #142: a Follow-up to a pull request that was merged, closed or deleted meanwhile
      // does not start the agent; the state is read right now, before anything else is done.
      if (
        (run.resumeReason === 'follow_up' || run.resumeReason === 'bring_up_to_date') &&
        this.options.lookups
      ) {
        const state = await this.options.lookups.followUpState(run, abort.signal);
        abort.signal.throwIfAborted();
        if (isEndedPullRequest(state)) {
          log.push(
            stepIndex,
            'notice',
            `Follow-up ${run.followUpNumber} not started: the pull request is ${state === 'missing' ? 'not found' : state}`,
          );
          throw new PullRequestEndedError(state, run.pullRequestNumber);
        }
      }
      // A resumed Run continues in the Working copy it kept (Issue #103).
      prepared =
        run.kind === 'resume'
          ? await this.options.workingCopies.locate(run, abort.signal)
          : await this.options.workingCopies.prepare(run, abort.signal);
      abort.signal.throwIfAborted();
      // Review S4 of #154: a new part starts from a clean state. A merge an earlier part left open
      // (cancelled while it waited, a crash, the usage limit and then another request) is aborted
      // first, so nothing of it is built on or committed. A later claim of the same part goes on.
      if (run.resumeReason === 'follow_up' || run.resumeReason === 'bring_up_to_date') {
        if (await this.options.branchUpdates.abort(prepared, undefined, abort.signal)) {
          log.push(stepIndex, 'notice', 'A merge an earlier part left open was aborted');
        }
      }
      if (run.resumeReason === 'bring_up_to_date') {
        log.push(
          stepIndex,
          'notice',
          `Follow-up ${run.followUpNumber} started: bring the branch up to date with ${run.integrationBranch}`,
        );
        // The Run's own changes count from the integration commit it last merged (review S1).
        let update: BranchUpdateStart | undefined;
        let notUpdated: string | undefined;
        try {
          update = await this.options.branchUpdates.start(prepared, run, abort.signal);
        } catch (error) {
          // Nothing was merged (review S2): the Run goes back to its earlier result, and the
          // conversation says why.
          if (!(error instanceof PreparationFailedError)) throw error;
          notUpdated = `${error.detail} Nothing was changed: the Run is as it was before the request.`;
        }
        abort.signal.throwIfAborted();
        if (update === undefined || update.outcome === 'already_up_to_date') {
          log.push(
            stepIndex,
            'notice',
            update === undefined
              ? `The branch was not updated: ${notUpdated}`
              : `The Run branch already has ${run.integrationBranch} (commit ${update.commit.slice(0, 7)}): nothing was changed`,
          );
          followUpEnded(
            run,
            stepIndex,
            log,
            update === undefined ? 'not updated' : 'already up to date',
          );
          followUpMarked = true;
          await this.closeLog(log);
          abort.signal.throwIfAborted();
          outbox.send('unchanged', (signal) =>
            api.reportState(
              run.runId,
              {
                state: 'succeeded',
                unchanged: true,
                ...(notUpdated === undefined
                  ? {}
                  : { unchangedDetail: notUpdated.slice(0, FAILURE_DETAIL_MAX_LENGTH) }),
              },
              signal,
            ),
          );
          await outbox.drain();
          if (outbox.lost) logger.error(`Run ${run.runId} is no longer held by this worker.`);
          else logger.info(`Run ${run.runId} reported: nothing changed.`);
          return;
        }
        expectedCommit = update.commit;
        baseCommit = update.baseCommit;
        prepared.diffBase = update.commit;
        mergeStarted = { baseCommit: update.baseCommit, integrationCommit: update.commit };
        log.push(
          stepIndex,
          'notice',
          update.outcome === 'merged'
            ? `Merged ${run.integrationBranch} (commit ${update.commit.slice(0, 7)}) without conflicts`
            : `Merging ${run.integrationBranch} (commit ${update.commit.slice(0, 7)}) conflicts in ${update.files.length + update.moreFiles} file(s)`,
        );
        instruction = bringUpToDateInstruction({
          integrationBranch: run.integrationBranch,
          start: update,
          note: run.answer === BRING_UP_TO_DATE_DEFAULT_TEXT ? '' : (run.answer ?? ''),
        });
      } else if (run.resumeReason === 'follow_up') {
        log.push(stepIndex, 'notice', `Follow-up ${run.followUpNumber} started`);
      } else if (run.resumeReason === 'usage_limit' && run.followUpNumber !== undefined) {
        // Review S7 of #150: the Follow-up the usage limit paused goes on.
        log.push(stepIndex, 'notice', `Follow-up ${run.followUpNumber} resumed`);
      }
      outbox.send('running', (signal) =>
        api.reportState(
          run.runId,
          {
            state: 'running',
            ...(mergeStarted === undefined ? {} : { bringUpToDateStarted: mergeStarted }),
          },
          signal,
        ),
      );
      processes = this.processesFor(prepared);
      const limit = setTimeout(
        () => {
          if (abort.signal.aborted) return;
          logger.info(`Run ${run.runId}: the run step reached its time limit.`);
          stop('timeout');
        },
        run.limits.stepMinutes * (this.options.minuteMs ?? 60_000),
      );
      let result: RunStepResult;
      try {
        result = await this.executeStep(
          run,
          stepIndex,
          prepared,
          processes,
          abort.signal,
          log,
          instruction,
        );
      } finally {
        clearTimeout(limit);
      }
      abort.signal.throwIfAborted();
      // Issue #147: a merge the agent left open (it resolved the conflicts but could not, or did
      // not, commit) is completed here; one it did not resolve is aborted by the error below.
      if (result.outcome === 'done' && run.bringUpToDate === true) {
        const completed = await this.options.branchUpdates.complete(
          prepared,
          run,
          abort.signal,
          expectedCommit,
        );
        if (completed?.completed) log.push(stepIndex, 'notice', 'The merge was completed');
      }
      if (result.outcome === 'done') {
        followUpEnded(run, stepIndex, log, 'done');
        followUpMarked = true;
      }
      // The log goes first: Studio accepts events only while the worker holds the Run.
      await this.closeLog(log);
      abort.signal.throwIfAborted();
      // What a done step left is committed before its report, so the report lists that commit;
      // a refused commit still lets the step's result be reported first (Issue #102).
      let commitFailure: DeliveryFailedError | undefined;
      if (result.outcome === 'done') {
        await this.options.deliveries
          .commit(prepared, run, result, abort.signal)
          .catch((error: unknown) => {
            if (!(error instanceof DeliveryFailedError)) throw error;
            commitFailure = error;
          });
      }
      const workingCopy = await this.options.workingCopies.report(prepared, abort.signal);
      outbox.send('step', (signal) =>
        api.reportStep(
          run.runId,
          // Numbered, so a retry of a report Studio already stored is not stored twice.
          {
            index: stepIndex,
            kind: run.kind === 'resume' ? 'resume' : 'start',
            result,
            workingCopy,
          },
          signal,
        ),
      );
      // Issue #144: the Run's diffs after every result, before the Run moves on (Studio takes
      // them only while this worker holds the Run).
      const diff = await this.computeDiff(run, prepared, abort.signal);
      outbox.send('diff', (signal) => api.reportDiff(run.runId, diff.report, signal));
      if (result.outcome === 'needs_input') {
        outbox.send('waiting_for_operator', (signal) =>
          api.reportState(run.runId, { state: 'waiting_for_operator' }, signal),
        );
      } else {
        if (commitFailure) throw commitFailure;
        // Nothing is pushed once a stop is pending (Issue #100).
        abort.signal.throwIfAborted();
        // From here a stop or a crash leaves a delivery to retry, not a lost Run (review of #122).
        this.delivering = true;
        const delivery = await this.options.deliveries.deliver(
          prepared,
          run,
          result,
          deliveryAbort.signal,
        );
        deliveryAbort.signal.throwIfAborted();
        if (delivery.outcome === 'delivered' && diff.computed) {
          await this.reportPushedDiff(run, prepared, diff.computed, outbox, deliveryAbort.signal);
        }
        if (abort.signal.aborted) {
          // Cancelled while the delivery ran: the Run ends cancelled with what was delivered,
          // so a pushed branch or an opened pull request is never left without a trace.
          logger.info(`Run ${run.runId}: cancelled during its delivery (${delivery.outcome}).`);
          await this.removeContainers(run);
          outbox.send('cancelled', (signal) =>
            api.reportState(run.runId, { state: 'cancelled', delivery }, signal),
          );
        } else {
          outbox.send('succeeded', (signal) =>
            api.reportState(run.runId, { state: 'succeeded', delivery }, signal),
          );
        }
      }
      await outbox.drain();
      if (outbox.lost) logger.error(`Run ${run.runId} is no longer held by this worker.`);
      else logger.info(`Run ${run.runId} reported: ${result.outcome}.`);
    } catch (error) {
      const reason =
        abort.signal.aborted && abort.signal.reason instanceof StepStoppedError
          ? abort.signal.reason.reason
          : undefined;
      if (reason === 'cancel') log.push(stepIndex, 'notice', 'Run step stopped: cancelled');
      if (reason === 'timeout') {
        log.push(
          stepIndex,
          'notice',
          `Run step stopped: its time limit of ${run.limits.stepMinutes} minutes was reached`,
        );
      }
      // A Follow-up ends with the step that did not finish (Issue #141); a failed delivery after
      // a done step already marked its end.
      if (run.kind !== 'deliver' && !followUpMarked && reason !== 'lost') {
        // Review S7 of #150: the usage limit pauses the Follow-up; a resume continues it.
        if (error instanceof UsageLimitError && reason === undefined) {
          if (run.followUpNumber !== undefined) {
            log.push(stepIndex, 'notice', `Follow-up ${run.followUpNumber} paused: usage limit`);
          }
        } else {
          followUpEnded(
            run,
            stepIndex,
            log,
            reason === 'cancel' ? 'cancelled' : reason === 'timeout' ? 'timed out' : 'failed',
          );
        }
      }
      if (reason !== 'lost') await this.closeLog(log);
      // Issue #147: a part that does not end well leaves nothing of the update behind: an open merge
      // is aborted and the Run branch goes back to its commit before the part (review S3 of #154).
      // Only the usage limit, which resumes the session, keeps it; a delivery that failed after a
      // done step keeps the merge for its retry.
      if (
        run.bringUpToDate === true &&
        prepared &&
        !(error instanceof UsageLimitError && reason === undefined) &&
        !(error instanceof DeliveryFailedError) &&
        !this.delivering
      ) {
        if (await this.options.branchUpdates.abort(prepared, baseCommit)) {
          logger.info(`Run ${run.runId}: the update was undone.`);
        }
      }
      await this.finish(run, error, reason, {
        prepared,
        stepStarted: processes !== undefined,
        outbox,
      });
    } finally {
      log.dispose();
      clearInterval(heartbeats);
      this.delivering = false;
      await processes?.release().catch((error: unknown) => {
        logger.error(`Forgetting the processes of run ${run.runId} failed: ${describe(error)}`);
      });
      this.stopCurrent = undefined;
      this.currentRunId = undefined;
    }
  }

  /**
   * A delivery retry (Issue #102): finds the Run's Working copy and the agent's kept result,
   * commits anything left and delivers; reports `succeeded` with the delivery and the Working
   * copy's state. Failures are reported by the caller, always as `delivery_failed`.
   */
  private async retryDelivery(
    run: RunPayload,
    signal: AbortSignal,
    outbox: ReportOutbox,
    located: (prepared: PreparedRun) => void,
  ): Promise<void> {
    const { deliveries, workingCopies, api, logger } = this.options;
    const { prepared, result } = await deliveries.locate(run);
    located(prepared);
    await deliveries.commit(prepared, run, result, signal);
    // Issue #144 (review S-2 of #149): the diffs again, whatever the delivery's outcome, so a
    // result whose diff report was lost still gets one; once pushed, again as pushed.
    const diff = await this.computeDiff(run, prepared, signal, true);
    outbox.send('diff', (reportSignal) => api.reportDiff(run.runId, diff.report, reportSignal));
    const delivery = await deliveries.deliver(prepared, run, result, signal);
    signal.throwIfAborted();
    if (delivery.outcome === 'delivered' && diff.computed) {
      await this.reportPushedDiff(run, prepared, diff.computed, outbox, signal);
    }
    const workingCopy = await workingCopies.report(prepared, signal);
    outbox.send('succeeded', (reportSignal) =>
      api.reportState(run.runId, { state: 'succeeded', delivery, workingCopy }, reportSignal),
    );
    await outbox.drain();
    if (outbox.lost) logger.error(`Run ${run.runId} is no longer held by this worker.`);
    else logger.info(`Run ${run.runId} delivered on retry: ${delivery.outcome}.`);
  }

  /**
   * The Run's diffs (Issue #144), or, when they cannot be computed, a report that says why. An
   * abort is not a failure of the diff: it goes on to stop the Run.
   */
  private async computeDiff(
    run: RunPayload,
    prepared: PreparedRun,
    signal: AbortSignal,
    refresh = false,
  ): Promise<{ computed?: ComputedRunDiff; report: RunDiffReport }> {
    try {
      const computed = await this.options.diffs.compute(prepared, run, signal, { refresh });
      return { computed, report: computed.report };
    } catch (error) {
      signal.throwIfAborted();
      const detail =
        error instanceof RunDiffUnavailableError
          ? error.detail
          : 'The changes could not be computed. The agent worker log has the details.';
      if (!(error instanceof RunDiffUnavailableError)) {
        this.options.logger.error(
          `Computing the diff of run ${run.runId} failed: ${describe(error)}`,
        );
      }
      return { report: { unavailable: detail } };
    }
  }

  /** After a push: the same diffs, now saying their changes are pushed (Issue #144). */
  private async reportPushedDiff(
    run: RunPayload,
    prepared: PreparedRun,
    computed: ComputedRunDiff,
    outbox: ReportOutbox,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const report = await this.options.diffs.pushed(prepared, computed, signal);
      outbox.send('diff', (reportSignal) =>
        this.options.api.reportDiff(run.runId, report, reportSignal),
      );
    } catch (error) {
      signal.throwIfAborted();
      // The stored diffs stay; they only still say "not pushed".
      this.options.logger.error(
        `Recording the pushed diff of run ${run.runId} failed: ${describe(error)}`,
      );
    }
  }

  /**
   * Delivers the Run's buffered log before its end report: through a Studio outage (Issue #100),
   * but only {@link SHUTDOWN_LOG_DEADLINE_MS} more once the worker stops.
   */
  private async closeLog(log: RunLog): Promise<void> {
    const shutdown = this.shutdown.signal;
    if (shutdown.aborted) return log.close(SHUTDOWN_LOG_DEADLINE_MS);
    let onStop: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      onStop = () => resolve();
      shutdown.addEventListener('abort', onStop, { once: true });
    });
    await Promise.race([log.close(LOG_OUTAGE_DEADLINE_MS), stopped]);
    shutdown.removeEventListener('abort', onStop!);
    // A later close sets the shorter deadline on the same delivery.
    if (shutdown.aborted) await log.close(SHUTDOWN_LOG_DEADLINE_MS);
  }

  private processesFor(prepared: PreparedRun): StepProcessGroups {
    return (
      this.options.processesFor?.(prepared) ??
      new StepProcesses(posix.join(prepared.runDir, STEP_PROCESSES_FILE))
    );
  }

  /**
   * Runs one Run step, the first or a resumed one (Issue #103), its events forwarded between a
   * start and an end marker (Issue #99). However it ends, the step's process groups are
   * terminated afterwards (SIGINT, the grace, SIGKILL): when the step is stopped this is what
   * stops it, and otherwise nothing it started outlives it. A stopped step that does not end
   * within the grace (a runner that ignores the abort) is abandoned.
   */
  private async executeStep(
    run: RunPayload,
    stepIndex: number,
    prepared: PreparedRun,
    processes: StepProcessGroups,
    signal: AbortSignal,
    log: RunLog,
    instruction?: string,
  ): Promise<RunStepResult> {
    const workspace = { repoDir: prepared.repoDir, runDir: prepared.runDir, env: prepared.env };
    // The Environment file is in the Working copy (Issue #104); its content goes to the runner
    // no other way (never in a prompt, an argument or the process environment).
    const { environmentFile, ...forRunner } = run;
    void environmentFile;
    const input = {
      run: forRunner,
      workspace,
      signal,
      processes,
      agentDefinition: AGENT_DEFINITION,
    };
    log.push(stepIndex, 'step_started', `Run step ${stepIndex} started`);
    const runnerStep =
      run.kind === 'resume' && run.sessionRef !== undefined && run.answer !== undefined
        ? this.options.runner.resume({
            ...input,
            sessionRef: run.sessionRef,
            // Issue #147: after a bring-up-to-date merge the agent gets the worker's instruction.
            answer: instruction ?? run.answer,
            reason: run.resumeReason ?? 'answer',
          })
        : this.options.runner.start(input);
    const step = drainRunStep(runnerStep, (event) => log.push(stepIndex, event.type, event.text));
    const stopped = rejectOnAbort(signal);
    // An abandoned step's late end, or a stop after the step ended, must not surface as an
    // unhandled rejection.
    step.catch(() => undefined);
    stopped.catch(() => undefined);
    let result: RunStepResult;
    try {
      result = await Promise.race([step, stopped]);
    } catch (error) {
      log.push(stepIndex, 'step_finished', `Run step ${stepIndex} ended without a result`);
      throw error;
    } finally {
      const killed = await processes.terminate(this.options.killGraceMs, step);
      if (killed.length > 0) {
        this.options.logger.info(
          `Run ${run.runId}: killed ${killed.length} process group(s) after the grace period.`,
        );
      }
    }
    const parsed = runStepResultSchema.safeParse(result);
    if (!parsed.success) {
      log.push(stepIndex, 'step_finished', `Run step ${stepIndex} ended with an invalid result`);
      throw new InvalidResultError();
    }
    log.push(stepIndex, 'step_finished', `Run step ${stepIndex} finished: ${parsed.data.outcome}`);
    return parsed.data;
  }

  /** Reports how a Run ended when its step did not end normally. */
  private async finish(
    run: RunPayload,
    error: unknown,
    reason: StopReason | undefined,
    context: { prepared: PreparedRun | undefined; stepStarted: boolean; outbox: ReportOutbox },
  ): Promise<void> {
    const { api, logger } = this.options;
    const { prepared, outbox } = context;
    // The Run's containers go with any stop once its step has started (Issue #100).
    if (reason !== undefined && context.stepStarted) await this.removeContainers(run);
    if (reason === 'lost' || outbox.lost || isRunLost(error)) {
      logger.error(`Run ${run.runId} is no longer held by this worker; dropping it.`);
      return;
    }
    // What the stopped, failed or crashed step left in the Working copy (coordinator decision
    // on #98), when it can be read; the end is reported either way.
    const workingCopy = prepared ? await this.readWorkingCopy(run, prepared) : undefined;
    const withWorkingCopy = workingCopy ? { workingCopy } : {};
    // A delivery (retry or first) that did not finish leaves a delivery to retry (Issue #102);
    // only an operator's cancel ends a first delivery as cancelled.
    const inDelivery = run.kind === 'deliver' || (this.delivering && reason !== 'cancel');
    if (inDelivery) {
      const deliveryFailure = this.deliveryFailure(error);
      if (deliveryFailure === DELIVERY_UNEXPECTED_FAILURE) {
        logger.error(`Run ${run.runId} stopped unexpectedly: ${describe(error)}`);
      }
      const send = (signal?: AbortSignal) =>
        api.reportState(
          run.runId,
          {
            state: 'failed',
            failure: deliveryFailure,
            ...withWorkingCopy,
            // Review S2 of #150: what the delivery pushed before it failed.
            ...(error instanceof DeliveryFailedError && error.pushedCommit !== undefined
              ? { pushedCommit: error.pushedCommit }
              : {}),
          },
          signal,
        );
      try {
        if (this.stopping) await send();
        else {
          outbox.send('failed', send);
          await outbox.drain();
        }
        logger.info(`Run ${run.runId} reported: failed (delivery_failed).`);
      } catch (reportError) {
        logger.error(`Reporting run ${run.runId} as failed failed: ${describe(reportError)}`);
      }
      return;
    }
    if (this.stopping || reason === 'shutdown') {
      try {
        // Not tied to the shutdown signal and not queued: on stop this is the report that must
        // still go out (bounded by the request timeout).
        await api.reportState(run.runId, {
          state: 'failed',
          failure: SHUTDOWN_FAILURE,
          ...withWorkingCopy,
        });
        logger.info(`Run ${run.runId} reported: failed (${SHUTDOWN_FAILURE.code}).`);
      } catch (reportError) {
        logger.error(`Reporting run ${run.runId} as failed failed: ${describe(reportError)}`);
      }
      return;
    }
    if (reason === 'cancel' || reason === 'timeout') {
      const state = reason === 'cancel' ? 'cancelled' : 'timed_out';
      // Cancelled while delivering, after the push but before a pull request (review of #124):
      // the pushed Run branch is recorded.
      const pushed =
        reason === 'cancel' && error instanceof DeliveryFailedError && error.branchPushed
          ? {
              delivery: {
                outcome: 'none' as const,
                branchPushed: true as const,
                ...(error.pushedCommit === undefined ? {} : { pushedCommit: error.pushedCommit }),
              },
            }
          : {};
      outbox.send(state, (signal) =>
        api.reportState(run.runId, { state, ...withWorkingCopy, ...pushed }, signal),
      );
      await outbox.drain();
      logger.info(`Run ${run.runId} reported: ${state}.`);
      return;
    }
    const failure = failureOf(error);
    if (failure === UNEXPECTED_FAILURE) {
      logger.error(`Run ${run.runId} stopped unexpectedly: ${describe(error)}`);
    }
    // Issue #105: the session a Run stopped at the usage limit resumes later. Issue #142: the
    // pull request state a refused Follow-up read, so Studio shows it at once.
    const session =
      error instanceof UsageLimitError && error.sessionRef !== undefined
        ? { sessionRef: error.sessionRef }
        : error instanceof PullRequestEndedError
          ? { pullRequestState: error.state }
          : {};
    outbox.send('failed', (signal) =>
      api.reportState(
        run.runId,
        { state: 'failed', failure, ...withWorkingCopy, ...session },
        signal,
      ),
    );
    await outbox.drain();
    logger.info(`Run ${run.runId} reported: failed (${failure.code}).`);
  }

  /** A delivery fails only as `delivery_failed`, so it can be retried again. */
  private deliveryFailure(error: unknown): RunFailure {
    if (error instanceof DeliveryFailedError) return failure('delivery_failed', error.detail);
    return this.stopping ? DELIVERY_SHUTDOWN_FAILURE : DELIVERY_UNEXPECTED_FAILURE;
  }

  /** Removes the Run's containers, networks and volumes; a failure is logged (retention retries). */
  private async removeContainers(run: RunPayload): Promise<void> {
    try {
      await this.options.resources.cleanUp(composeProjectName(run.runId));
    } catch (error) {
      this.options.logger.error(
        `Removing the containers of run ${run.runId} failed: ${describe(error)}`,
      );
    }
  }

  /** The Working copy's state for an end report, or `undefined` if it cannot be read in time. */
  private async readWorkingCopy(
    run: RunPayload,
    prepared: PreparedRun,
  ): Promise<WorkingCopyReport | undefined> {
    try {
      return await this.options.workingCopies.report(
        prepared,
        AbortSignal.timeout(FAILURE_REPORT_TIMEOUT_MS),
      );
    } catch (error) {
      this.options.logger.error(
        `Reading the Working copy of run ${run.runId} failed: ${describe(error)}`,
      );
      return undefined;
    }
  }

  /** Never throws: a failed status report is logged, and the loop goes on. */
  private async reportStatus(): Promise<void> {
    try {
      const disk = this.options.disk?.snapshot();
      await this.options.api.reportStatus(
        disk ? { ...this.options.status, disk } : this.options.status,
        this.shutdown.signal,
      );
    } catch (error) {
      if (!this.stopping)
        this.options.logger.error(`Reporting the status failed: ${describe(error)}`);
    }
  }

  private async pause(ms: number): Promise<void> {
    try {
      await delay(ms, undefined, { signal: this.shutdown.signal });
    } catch {
      // Woken by stop().
    }
  }
}

/**
 * Marks the end of the Follow-up the Run is working on (Issue #141), when there is one: its
 * step ended `done`, or did not finish.
 */
function followUpEnded(run: RunPayload, stepIndex: number, log: RunLog, outcome: string): void {
  if (run.followUpNumber === undefined) return;
  log.push(stepIndex, 'notice', `Follow-up ${run.followUpNumber} ended: ${outcome}`);
}

/** The failure a Run step's error is reported with. */
function failureOf(error: unknown): RunFailure {
  if (error instanceof PreparationFailedError) return failure('preparation_failed', error.detail);
  if (error instanceof PullRequestEndedError) return failure('preparation_failed', error.message);
  if (error instanceof ProviderDisabledError) return failure('provider_disabled', error.message);
  if (error instanceof StepLimitError) return failure('step_limit', error.message);
  if (error instanceof AgentFailedError) return failure('agent_failed', error.message);
  // Issue #147: the agent ended without resolving the conflicts; the merge was aborted.
  if (error instanceof MergeIncompleteError) return failure('agent_failed', error.message);
  if (error instanceof UsageLimitError) return failure('usage_limit', error.message);
  if (error instanceof InvalidResultError) return INVALID_RESULT_FAILURE;
  // A refused commit of a done step (Issue #102).
  if (error instanceof DeliveryFailedError) return failure('delivery_failed', error.detail);
  return UNEXPECTED_FAILURE;
}

/** A failure with its detail cut to the protocol's limit. */
function failure(code: RunFailure['code'], detail: string): RunFailure {
  return { code, detail: detail.slice(0, FAILURE_DETAIL_MAX_LENGTH) };
}

/** Rejects with the signal's reason once it aborts. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason as Error);
    else signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

/** The pull request states in which a Follow-up has nothing left to update (Issue #142). */
const ENDED_PULL_REQUEST_STATES = ['merged', 'closed', 'missing'] as const;
type EndedPullRequestState = (typeof ENDED_PULL_REQUEST_STATES)[number];

function isEndedPullRequest(state: string): state is EndedPullRequestState {
  return (ENDED_PULL_REQUEST_STATES as readonly string[]).includes(state);
}

/**
 * The pull request a Follow-up would update is over (Issue #142): the Run ends as failed with
 * this detail before any agent CLI starts.
 */
class PullRequestEndedError extends Error {
  constructor(
    readonly state: EndedPullRequestState,
    number: number | undefined,
  ) {
    const pull = number === undefined ? 'The pull request' : `The pull request #${number}`;
    super(
      state === 'missing'
        ? `${pull} or the Run branch was not found on GitHub (it may be gone, or the Agent account cannot see it), so the Follow-up was not started. Start a new run for further changes.`
        : `${pull} was ${state} on GitHub, so the Follow-up was not started. Start a new run for further changes.`,
    );
    this.name = 'PullRequestEndedError';
  }
}

class InvalidResultError extends Error {
  constructor() {
    super('invalid structured result');
    this.name = 'InvalidResultError';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
