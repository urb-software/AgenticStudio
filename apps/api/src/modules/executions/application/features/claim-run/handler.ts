import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  RUN_DIFF_REPOSITORY,
  type RunDiffRepository,
} from '../../../domain/repositories/run-diff-repository.js';
import { SECRET_STORE, type SecretStore } from '../../../../../platform/secrets/index.js';
import {
  PROJECT_KINDS,
  type ProjectKinds,
  RUN_ENVIRONMENT_FILES,
  type RunEnvironmentFiles,
} from '../../../../projects/contracts/index.js';
import { RUN_ENVIRONMENT_FILE_SECRET_OWNER } from '../../ports/environment-file-snapshots.js';
import { IllegalRunTransitionError, RunNotHeldError } from '../../../domain/errors/run-errors.js';
import type { Run } from '../../../domain/entities/run.js';
import type { Provider } from '../../../domain/value-objects/provider.js';
import type { RunAgentData } from '../../../domain/value-objects/run-agent.js';
import type { RunHandOut } from '../../../domain/value-objects/run-hand-out.js';
import type { RunState } from '../../../domain/value-objects/run-state.js';
import { RunFailure } from '../../../domain/value-objects/run-failure.js';
import { RUN_LOG, type RunLog } from '../../ports/run-log.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import {
  ENVIRONMENT_FILE_SNAPSHOTS,
  type EnvironmentFileSnapshots,
} from '../../ports/environment-file-snapshots.js';
import { LongWaitRule } from '../../../domain/value-objects/long-wait-rule.js';
import { LostWorkerRule } from '../../../domain/value-objects/lost-worker-rule.js';
import { OverdueStepRule } from '../../../domain/value-objects/overdue-step-rule.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';

const ENVIRONMENT_FILE_UNAVAILABLE = RunFailure.of(
  'preparation_failed',
  "Studio could not read the project's Environment file for this run. Start the run again; " +
    'if it keeps failing, set the Environment file again.',
);

/** The object ids a claimed Run's agent worker resumes its diffs from. */
export interface ClaimedDiffState {
  resultTree: string;
  resultCommit: string;
  previousTree: string;
  previousCommit: string;
  pushedCommit?: string;
}

/** What the agent worker needs to prepare and run a claimed Run. */
export interface ClaimedRun {
  id: string;
  projectId: string;
  provider: Provider;
  /** The agent the Run recorded at start; every claim hands it out unchanged. */
  agent: RunAgentData;
  task: string;
  startCommit: string;
  remoteUrl: string;
  integrationBranch: string;
  state: RunState;
  workingCopy: { runBranch: string } | null;
  pullRequest: { number: number } | null;
  sessionRef: string | null;
  pushedCommit: string | null;
  followUpCount: number;
  stepsBeforePart: number;
  limits: { stepMinutes: number; maxSteps: number };
  handOut: Exclude<RunHandOut, { kind: 'refused' }>;
  /** Test values only; goes to the claiming worker, never logged. */
  environmentFile: { path: string; content: string } | null;
  replaceEnvironmentFile: boolean;
  /** Never committed or pushed. */
  studioPaths: string[];
  completedSteps: number;
  nextSeq: number;
  diffState?: ClaimedDiffState | null;
}

type ClaimExtras = Pick<
  ClaimedRun,
  | 'environmentFile'
  | 'replaceEnvironmentFile'
  | 'studioPaths'
  | 'completedSteps'
  | 'nextSeq'
  | 'diffState'
>;

const claimedRun = (run: Run, handOut: ClaimedRun['handOut'], extras: ClaimExtras): ClaimedRun => ({
  id: run.id,
  projectId: run.projectId,
  provider: run.provider,
  agent: run.agent.toData(),
  task: run.task,
  startCommit: run.startCommit,
  remoteUrl: run.remoteUrl,
  integrationBranch: run.delivery.integrationBranch,
  state: run.lifecycle.state,
  workingCopy: run.workingCopy ? { runBranch: run.workingCopy.runBranch } : null,
  pullRequest: run.delivery.pullRequest ? { number: run.delivery.pullRequest.number } : null,
  sessionRef: run.claim.sessionRef,
  pushedCommit: run.delivery.pushedCommit,
  followUpCount: run.progress.followUpCount,
  stepsBeforePart: run.progress.stepsBeforePart,
  limits: {
    stepMinutes: run.progress.limits.stepMinutes,
    maxSteps: run.progress.limits.maxSteps,
  },
  handOut,
  ...extras,
});

export interface ClaimRunInput {
  workerId: string;
}

export type ClaimRunResult = ClaimedRun | null;

const studioPathsOf = (run: Run): string[] =>
  run.claim.environmentFilePath ? [run.claim.environmentFilePath] : [];

const SNAPSHOT_FAILED = Symbol('SNAPSHOT_FAILED');

/**
 * `null` when no Run is eligible. A resume goes only to the worker that last claimed the Run. A
 * Follow-up, or a usage-limit resume inside one, takes the Project's current Environment file;
 * other resumes keep their snapshot. The definitions Project's Runs are never handed out.
 */
@Injectable()
export class ClaimRunHandler {
  private readonly logger = new Logger('ClaimRun');

  constructor(
    @Inject(PROJECT_KINDS) private readonly kinds: ProjectKinds,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_LOG) private readonly logs: RunLog,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
    @Inject(RUN_ENVIRONMENT_FILES) private readonly environmentFiles: RunEnvironmentFiles,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(ENVIRONMENT_FILE_SNAPSHOTS) private readonly snapshots: EnvironmentFileSnapshots,
    @Inject(RUN_DIFF_REPOSITORY) private readonly diffs: RunDiffRepository,
  ) {}

  async execute(input: ClaimRunInput): Promise<ClaimRunResult> {
    const { workerId } = input;
    const now = this.clock.now();
    // Sweeps first, so lost workers free their places and long-waiting Runs
    // end before the hand-out.
    const lost = LostWorkerRule.at(now, this.lease.seconds);
    await this.runs.failStaleClaims(lost.staleBefore, lost.failure, lost.deliveryFailure, now);
    for (const waiting of await this.runs.listWaiting()) {
      const cancellation = LongWaitRule.at(now).cancellationFor(waiting.sweepFacts());
      // An answer or an operator's cancel in between wins: the Run then refuses.
      if (cancellation) {
        await this.runs.change(waiting.id, (locked) => {
          locked.cancelAfterWaiting(cancellation, now);
        });
      }
    }
    const overdue = OverdueStepRule.at(now);
    await this.runs.timeOutOverdueSteps(overdue.now, overdue.graceMinutes);
    const excluded = await this.kinds.definitionsProjectId();
    for (;;) {
      const run = await this.runs.claimNext(workerId, now, excluded);
      if (!run) return null;
      const handOut = run.handOut();
      switch (handOut.kind) {
        case 'refused':
          if (handOut.as === 'delivery') {
            await this.failDelivery(run, workerId, handOut.failure, now);
            await this.snapshots.releaseFor(run.id);
          } else {
            await this.fail(run, workerId, handOut.failure, now);
          }
          continue;
        case 'deliver':
          return claimedRun(run, handOut, {
            environmentFile: null,
            replaceEnvironmentFile: false,
            studioPaths: studioPathsOf(run),
            ...(await this.progress(run)),
          });
        case 'resume': {
          if (!handOut.newEnvironmentFile) {
            return claimedRun(run, handOut, {
              environmentFile: null,
              replaceEnvironmentFile: false,
              studioPaths: studioPathsOf(run),
              ...(await this.progress(run)),
            });
          }
          const environmentFile = await this.snapshot(run, workerId, now, true);
          if (environmentFile === SNAPSHOT_FAILED) continue;
          return claimedRun(run, handOut, {
            environmentFile,
            replaceEnvironmentFile: true,
            // The earlier file's path too: the worker removes it, and it is never committed.
            studioPaths: [
              ...new Set([
                ...studioPathsOf(run),
                ...(environmentFile ? [environmentFile.path] : []),
              ]),
            ],
            ...(await this.progress(run)),
          });
        }
        case 'start': {
          const environmentFile = await this.snapshot(run, workerId, now);
          if (environmentFile === SNAPSHOT_FAILED) continue;
          return claimedRun(run, handOut, {
            environmentFile,
            replaceEnvironmentFile: false,
            studioPaths: environmentFile ? [environmentFile.path] : [],
            completedSteps: 0,
            nextSeq: 1,
          });
        }
      }
    }
  }

  /**
   * `null` when the Project has no file. A failure fails the Run instead of starting without it.
   * `replace` deletes the Run's earlier snapshot first.
   */
  private async snapshot(
    run: Run,
    workerId: string,
    now: Date,
    replace = false,
  ): Promise<{ path: string; content: string } | null | typeof SNAPSHOT_FAILED> {
    let secretRef: string | undefined;
    try {
      if (replace) await this.snapshots.releaseFor(run.id);
      const file = await this.environmentFiles.forProject(run.projectId);
      if (!file) {
        // A claim that does not replace has no file to record (nothing was supplied before).
        if (replace) await this.recordEnvironmentFile(run.id, workerId, null);
        return null;
      }
      secretRef = await this.secrets.put(file.content, {
        owner: RUN_ENVIRONMENT_FILE_SECRET_OWNER,
      });
      await this.recordEnvironmentFile(run.id, workerId, { path: file.path, secretRef });
      return file;
    } catch (error) {
      // Only the error's class name: nothing logged here can hold the content.
      this.logger.error(
        `The Environment file of run ${run.id} could not be prepared: ${errorName(error)}`,
      );
    }
    if (secretRef !== undefined) await this.secrets.delete(secretRef).catch(() => undefined);
    await this.fail(run, workerId, ENVIRONMENT_FILE_UNAVAILABLE, now);
    return SNAPSHOT_FAILED;
  }

  private async progress(
    run: Run,
  ): Promise<{ completedSteps: number; nextSeq: number; diffState: ClaimedDiffState | null }> {
    const [lastSeq, diffState] = await Promise.all([
      this.logs.lastSeq(run.id),
      this.diffs.findState(run.id),
    ]);
    return {
      completedSteps: run.progress.stepCount,
      nextSeq: lastSeq + 1,
      diffState: diffState === null ? null : diffState.toData(),
    };
  }

  /** The Run holds the Environment file only while this worker still holds it preparing. */
  private async recordEnvironmentFile(
    runId: string,
    workerId: string,
    file: { path: string; secretRef: string } | null,
  ): Promise<void> {
    const recorded = await this.runs.change(runId, (run) =>
      run.recordEnvironmentFile(workerId, file),
    );
    if (!recorded) throw new Error('The run is no longer held for its claim.');
  }

  private async failDelivery(
    run: Run,
    workerId: string,
    failure: RunFailure,
    now: Date,
  ): Promise<void> {
    await this.runs.change(run.id, (held) => {
      try {
        held.reportState(workerId, { state: 'failed', failure }, now);
      } catch (error) {
        // Lost its claim meanwhile: nothing to finish (the sweep failed it).
        if (!(error instanceof RunNotHeldError || error instanceof IllegalRunTransitionError)) {
          throw error;
        }
      }
    });
  }

  private async fail(run: Run, workerId: string, failure: RunFailure, now: Date): Promise<void> {
    await this.runs.change(run.id, (preparing) => {
      preparing.failPreparation(workerId, failure, now);
    });
  }
}

function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : 'Error';
}
