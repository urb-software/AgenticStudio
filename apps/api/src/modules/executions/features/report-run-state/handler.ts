import { Inject, Injectable } from '@nestjs/common';
import {
  assertTransition,
  isRunId,
  type Run,
  type RunFailure,
  type RunState,
} from '../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  RunNotHeldError,
  type RunRepository,
} from '../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

export interface ReportRunStateInput {
  runId: string;
  workerId: string;
  /** One of the states a worker reports (the shared contract restricts it). */
  state: RunState;
  /** Exactly when `state` is `failed`. */
  failure: RunFailure | null;
}

/**
 * Command (Issue #96): the agent worker holding a Run reports a change of state. Throws
 * {@link RunNotFoundError}, {@link RunNotHeldError} (another worker holds it, or nobody does)
 * or `IllegalRunTransitionError`.
 */
@Injectable()
export class ReportRunStateHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
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
      now: this.clock.now(),
    });
    // The Run changed between the read and the write (e.g. the sweep failed it).
    if (!changed) throw new RunNotHeldError();
    return changed;
  }
}
