import { Inject, Injectable } from '@nestjs/common';
import {
  assertTransition,
  isFinal,
  isRunId,
  type Run,
  type RunFailure,
  type RunState,
  type RunWorkingCopy,
} from '../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  RunNotHeldError,
  type RunRepository,
} from '../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RUN_LOG_SIGNAL, type RunLogSignal } from '../../ports/run-log-signal.js';
import { ReleaseEnvironmentFileSnapshotsHandler } from '../release-environment-file-snapshots/handler.js';

export interface ReportRunStateInput {
  runId: string;
  workerId: string;
  /** One of the states a worker reports (the shared contract restricts it). */
  state: RunState;
  /** Exactly when `state` is `failed`. */
  failure: RunFailure | null;
  /** A failed Run's Working copy state, when the worker could read it (Issue #98). */
  workingCopy?: RunWorkingCopy | null;
}

/**
 * Command (Issue #96): the agent worker holding a Run reports a change of state. Throws
 * {@link RunNotFoundError}, {@link RunNotHeldError} (another worker holds it, or nobody does)
 * or `IllegalRunTransitionError`. Wakes the Run's live log streams; a final Run's Environment
 * file snapshot is deleted (Issue #104).
 */
@Injectable()
export class ReportRunStateHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RUN_LOG_SIGNAL) private readonly signal: RunLogSignal,
    private readonly snapshots: ReleaseEnvironmentFileSnapshotsHandler,
  ) {}

  async execute(input: ReportRunStateInput): Promise<Run> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    const run = await this.runs.findById(input.runId);
    if (!run) throw new RunNotFoundError();
    if (run.claimedBy !== input.workerId) throw new RunNotHeldError();
    assertTransition(run.state, input.state);
    const changed = await this.runs.transitionClaimed({
      runId: run.id,
      workerId: input.workerId,
      from: run.state,
      to: input.state,
      failure: input.state === 'failed' ? input.failure : null,
      workingCopy: input.state === 'failed' ? (input.workingCopy ?? null) : null,
      now: this.clock.now(),
    });
    // The Run changed between the read and the write (e.g. the sweep failed it).
    if (!changed) throw new RunNotHeldError();
    // Live log streams re-read the state: a final Run ends them (Issue #99).
    this.signal.notify(run.id);
    // A final Run stores no more events: its Environment file snapshot goes (Issue #104).
    if (isFinal(changed.state)) await this.snapshots.releaseFor(run.id);
    return changed;
  }
}
