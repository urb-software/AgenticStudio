import type { EnvironmentFile } from '@agentic-studio/contracts';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RunDiffState } from '../../../domain/entities/run-diff.js';
import {
  RUN_DIFF_REPOSITORY,
  type RunDiffRepository,
} from '../../../domain/repositories/run-diff-repository.js';
import { SECRET_STORE, type SecretStore } from '../../../../../platform/secrets/index.js';
import {
  RUN_ENVIRONMENT_FILES,
  type RunEnvironmentFiles,
} from '../../../../projects/contracts/index.js';
import { RUN_ENVIRONMENT_FILE_SECRET_OWNER } from '../../../domain/entities/run-environment-file.js';
import {
  longWaitCancellation,
  lostWorkerRule,
  resumeMessage,
  type Run,
  type RunFailure,
  STEP_TIME_LIMIT_GRACE_MINUTES,
  takesNewEnvironmentFile,
} from '../../../domain/entities/run.js';
import {
  RUN_LOG_REPOSITORY,
  type RunLogRepository,
} from '../../../domain/repositories/run-log-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import {
  ENVIRONMENT_FILE_SNAPSHOTS,
  type EnvironmentFileSnapshots,
} from '../../ports/environment-file-snapshots.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';

const NO_REMOTE: RunFailure = {
  code: 'preparation_failed',
  detail:
    "The run has no repository remote to prepare from (the project's repository was removed).",
};

/**
 * Command (Issue #96): an agent worker asks for work. Lost workers are swept first (their
 * Runs fail and free their places), Runs waiting too long are cancelled and steps far past
 * their time limit time out (Issue #100); then the oldest eligible queued Run is handed out
 * under the concurrency limits; `null` when there is none. A `failed` Run whose delivery retry
 * was requested is handed out too, for the delivery only (Issue #102). Issue #104: when a
 * Run is started, the Project's Environment file is copied into a Run-scoped secret (the
 * Run's snapshot: log redaction uses it, and later changes to the file affect only later
 * Runs) and handed to the claiming worker only; the Run records its path.
 */
const NOT_DELIVERABLE: RunFailure = {
  code: 'delivery_failed',
  detail:
    'The run cannot be delivered: it has no repository remote, integration branch or recorded ' +
    'Run branch.',
};

const ENVIRONMENT_FILE_UNAVAILABLE: RunFailure = {
  code: 'preparation_failed',
  detail:
    "Studio could not read the project's Environment file for this run. Start the run again; " +
    'if it keeps failing, set the Environment file again.',
};

/** A resume with nothing recorded to resume in (Issue #103). */
const NOT_RESUMABLE: RunFailure = {
  code: 'preparation_failed',
  detail:
    'Working copy no longer exists — run again: Studio has no recorded Working copy, repository ' +
    'remote or integration branch for this run.',
};

/** A resume whose Working copy the agent worker reported removed (review S9 of #150). */
const WORKING_COPY_REMOVED: RunFailure = {
  code: 'preparation_failed',
  detail: "Working copy no longer exists — run again: the agent worker's retention removed it.",
};

/**
 * A claimed Run and what goes to the claiming worker with it: the Project's Environment file
 * as it was at the claim (Issue #104), or `null` when the Project has none or the claim is a
 * delivery retry or a resume (the file is already in the Working copy then); how many Run steps
 * it has taken and the seq of its next event (Issue #103: a resumed step continues after the
 * stored log).
 */
export interface ClaimedRun extends Run {
  environmentFile: EnvironmentFile | null;
  /**
   * Review S3 of #150: the claim carries a new snapshot of the Project's Environment file (or
   * none): the worker replaces the Studio-placed files in the Working copy with it.
   */
  replaceEnvironmentFile: boolean;
  /** Paths of the files Studio placed in the Working copy: never committed or pushed. */
  studioPaths: string[];
  completedSteps: number;
  nextSeq: number;
  /** With a resume or delivery claim: where the Run's diffs stand (Issue #144), if reported. */
  diffState?: RunDiffState | null;
}

/** The Studio-placed paths of a Run: its Environment file's, when it has one. */
const studioPathsOf = (run: Pick<Run, 'environmentFilePath'>): string[] =>
  run.environmentFilePath ? [run.environmentFilePath] : [];

/** The snapshot could not be taken; the Run was failed. */
const SNAPSHOT_FAILED = Symbol('SNAPSHOT_FAILED');

/**
 * Command (Issue #96): an agent worker asks for work. Lost workers are swept first (their
 * Runs fail and free their places), then the oldest eligible queued Run is handed out under
 * the concurrency limits; `null` when there is none. A `failed` Run whose delivery retry was
 * requested is handed out too, for the delivery only (Issue #102). Issue #104: when a Run is
 * started, the Project's Environment file is copied into a Run-scoped secret (the Run's
 * snapshot: log redaction uses it, and later changes to the file affect only later Runs) and
 * handed to the claiming worker only; the Run records its path. Issue #103: an answered Run is
 * handed out to resume its agent session, only to the worker that started it; it keeps the
 * snapshot it took at its start (no new one, and no content in the claim).
 */
@Injectable()
export class ClaimRunHandler {
  private readonly logger = new Logger('ClaimRun');

  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_LOG_REPOSITORY) private readonly logs: RunLogRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
    @Inject(RUN_ENVIRONMENT_FILES) private readonly environmentFiles: RunEnvironmentFiles,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(ENVIRONMENT_FILE_SNAPSHOTS) private readonly snapshots: EnvironmentFileSnapshots,
    @Inject(RUN_DIFF_REPOSITORY) private readonly diffs: RunDiffRepository,
  ) {}

  async execute(workerId: string): Promise<ClaimedRun | null> {
    const now = this.clock.now();
    const { staleBefore, failure, deliveryFailure } = lostWorkerRule(now, this.lease.seconds);
    await this.runs.failStaleClaims(staleBefore, failure, deliveryFailure, now);
    // A Run left waiting too long holds a slot; it is cancelled first (Issue #100).
    for (const waiting of await this.runs.listWaiting()) {
      const cancellation = longWaitCancellation(waiting, now);
      // Conditional: an answer or an operator's cancel in between wins.
      if (cancellation) {
        await this.runs.cancelUnheld(waiting.id, 'waiting_for_operator', cancellation, now);
      }
    }
    // A step far past its time limit holds a slot too (review of #121: Studio's backstop).
    await this.runs.timeOutOverdueSteps(now, STEP_TIME_LIMIT_GRACE_MINUTES);
    for (;;) {
      const run = await this.runs.claimNext(workerId, now);
      if (!run) return null;
      if (run.state === 'failed') {
        // A delivery retry (Issue #102): without a remote, an integration branch or a recorded
        // Run branch there is nothing to deliver; it fails again at once and is released
        // (review R5 of #122).
        if (run.remoteUrl !== '' && run.integrationBranch !== '' && run.workingCopy) {
          // Its events continue after the stored log (coordinator decision on #103).
          return {
            ...run,
            environmentFile: null,
            replaceEnvironmentFile: false,
            studioPaths: studioPathsOf(run),
            ...(await this.progress(run.id)),
          };
        }
        await this.runs.finishDeliveryRetry({
          runId: run.id,
          workerId,
          result: { state: 'failed', failure: NOT_DELIVERABLE },
          workingCopy: null,
          now,
        });
        // Nothing left to deliver, so nothing more to redact (Issue #104).
        await this.snapshots.releaseFor(run.id);
        continue;
      }
      // A Run from before Issue #98 whose project had no Repository has no remote to prepare
      // from (nor an integration branch, Issue #102): it fails with preparation_failed here
      // instead of reaching a worker (review S6).
      const reachable = run.remoteUrl !== '' && run.integrationBranch !== '';
      const resume = resumeMessage(run);
      if (resume !== null) {
        // Issue #103 (and a Follow-up, #141): the resumed step continues the Run's step
        // numbers and its log's seqs. Review S9 of #150: a Working copy the worker reported
        // removed (also while a Follow-up waited) cannot be resumed.
        if (!reachable || !run.workingCopy || run.workingCopyRemovedAt !== null) {
          const failure = run.workingCopyRemovedAt !== null ? WORKING_COPY_REMOVED : NOT_RESUMABLE;
          await this.fail(run, workerId, failure, now);
          continue;
        }
        if (!takesNewEnvironmentFile(run, resume.reason)) {
          return {
            ...run,
            environmentFile: null,
            replaceEnvironmentFile: false,
            studioPaths: studioPathsOf(run),
            ...(await this.progress(run.id)),
          };
        }
        // Review S3 of #150: a Follow-up works with the Project's current Environment file.
        const environmentFile = await this.snapshot(run, workerId, now, true);
        if (environmentFile === SNAPSHOT_FAILED) continue;
        return {
          ...run,
          environmentFileSupplied: environmentFile !== null,
          environmentFilePath: environmentFile?.path ?? null,
          environmentFile,
          replaceEnvironmentFile: true,
          // The earlier file's path too: the worker removes it, and it is never committed.
          studioPaths: [
            ...new Set([...studioPathsOf(run), ...(environmentFile ? [environmentFile.path] : [])]),
          ],
          ...(await this.progress(run.id)),
        };
      }
      if (!reachable) {
        await this.fail(run, workerId, NO_REMOTE, now);
        continue;
      }
      const environmentFile = await this.snapshot(run, workerId, now);
      if (environmentFile === SNAPSHOT_FAILED) continue;
      return {
        ...run,
        environmentFileSupplied: environmentFile !== null,
        environmentFilePath: environmentFile?.path ?? null,
        environmentFile,
        replaceEnvironmentFile: false,
        studioPaths: environmentFile ? [environmentFile.path] : [],
        completedSteps: 0,
        nextSeq: 1,
      };
    }
  }

  /**
   * The Project's current Environment file, stored as the Run's snapshot; `null` when it has
   * none. When it cannot be read or stored, the Run fails (preparation_failed) instead of
   * starting without the file it should have. `replace` (review S3 of #150, a Follow-up): the
   * Run's earlier snapshot is deleted first, and the new one (or none) is recorded in its place.
   */
  private async snapshot(
    run: Run,
    workerId: string,
    now: Date,
    replace = false,
  ): Promise<EnvironmentFile | null | typeof SNAPSHOT_FAILED> {
    let secretRef: string | undefined;
    try {
      if (replace) await this.snapshots.releaseFor(run.id);
      const file = await this.environmentFiles.forProject(run.projectId);
      if (!file) {
        if (!replace || (await this.runs.replaceEnvironmentFile(run.id, workerId, null))) {
          return null;
        }
        throw new Error('The run is no longer held for its claim.');
      }
      secretRef = await this.secrets.put(file.content, {
        owner: RUN_ENVIRONMENT_FILE_SECRET_OWNER,
      });
      const attached = replace
        ? await this.runs.replaceEnvironmentFile(run.id, workerId, { path: file.path, secretRef })
        : await this.runs.attachEnvironmentFile(run.id, workerId, { path: file.path, secretRef });
      if (attached) {
        return file;
      }
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

  /**
   * How many Run steps the Run has taken and the seq after its stored log (Issue #103), and where
   * its diffs stand (Issue #144, review S-1 of #149).
   */
  private async progress(
    runId: string,
  ): Promise<{ completedSteps: number; nextSeq: number; diffState: RunDiffState | null }> {
    const [steps, lastSeq, diffState] = await Promise.all([
      this.runs.listSteps(runId),
      this.logs.lastSeq(runId),
      this.diffs.findState(runId),
    ]);
    return { completedSteps: steps.length, nextSeq: lastSeq + 1, diffState };
  }

  private async fail(run: Run, workerId: string, failure: RunFailure, now: Date): Promise<void> {
    await this.runs.transitionClaimed({
      runId: run.id,
      workerId,
      from: 'preparing',
      to: 'failed',
      failure,
      cancelRequested: false,
      now,
    });
  }
}

function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : 'Error';
}
