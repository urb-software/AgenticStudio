import { Inject, Injectable } from '@nestjs/common';
import {
  RUN_REPOSITORY,
  type RunRepository,
  type RunStateView,
} from '../../../domain/repositories/run-repository.js';
import type { Provider } from '../../../domain/entities/run.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RETENTION_POLICY, type RetentionPolicy } from '../../ports/retention-policy.js';

/**
 * A Run's state with what the agent worker does with its Working copy (Issue #143): the
 * worker protocol's `RunStatesResponse` entry, with Dates (the endpoint serialises and validates
 * it against that contract).
 */
export interface RunRetentionAnswer {
  runId: string;
  state: RunStateView['state'];
  finishedAt: Date | null;
  /** Set for a final Run whose Working copy is kept at least until then. */
  keepUntil?: Date;
  /** Set for a final Run whose Working copy is to be removed now. */
  removable?: true;
  /** With `removable`: the Run's agent session, for removing its CLI session files. */
  session?: { provider: Provider; ref: string };
}

export interface GetRunStatesInput {
  runIds: readonly string[];
  /** Issue #141: the Runs whose Working copies the worker's retention removed. */
  removed?: { workerId: string; runIds: readonly string[] };
}

export type GetRunStatesResult = RunRetentionAnswer[];

/**
 * Query (Issue #98, #143): the agent worker asks for the Runs it keeps Working copies for, to
 * apply the retention. Studio decides, from what it holds: a Run that is not final (queued,
 * preparing, running, waiting for the operator) has no answer to remove it. A final Run with a
 * pull request is kept until the earlier of 24 hours after the pull request ended and 30 days
 * without activity; one in an unknown state counts as open, so a Git host outage removes
 * nothing. Any other final Run is kept seven days from its latest result and, beyond the newest
 * ten of its Project, removable at once (the per-Project limit counts only those Runs and never
 * removes a Run with a pull request). The periods and limits are the `STUDIO_RETENTION_*`
 * settings. Ids that name no Run are left out, so the worker removes their directories. The
 * shared contract has validated every id as a UUID. Issue #141: the worker also reports the Runs
 * whose Working copies its retention removed; Studio records it (only for final Runs that worker
 * holds the Working copy of), so their pages say a Follow-up is no longer possible.
 */
@Injectable()
export class GetRunStatesHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RETENTION_POLICY) private readonly policy: RetentionPolicy,
  ) {}

  async execute(input: GetRunStatesInput): Promise<GetRunStatesResult> {
    const { runIds, removed } = input;
    const now = this.clock.now();
    // Each Run is changed under its own row lock (Issue #169): a Follow-up queued meanwhile
    // either took the Working copy before this report or finds it removed.
    for (const runId of new Set(removed?.runIds ?? [])) {
      await this.runs.change(runId, (run) => {
        run.reportWorkingCopyRemoved(removed!.workerId, now);
      });
    }
    const views = await this.runs.findStates([...new Set(runIds)]);
    const limited = views.filter(
      (view): view is RunStateView & { finishedAt: Date } =>
        view.finishedAt !== null && this.policy.isLimited(view),
    );
    // The limit counts every such Run of the Project that still has its Working copy, not only
    // the ones this request asks about (the worker asks in batches).
    const over = this.policy.overLimit(
      await this.runs.findLimitedRuns([...new Set(limited.map((view) => view.projectId))]),
    );
    return views.map((view) => {
      const until = this.policy.keepUntil(view);
      const answer = { runId: view.runId, state: view.state, finishedAt: view.finishedAt };
      if (until === null) return answer;
      const removable = until.getTime() <= now.getTime() || over.has(view.runId);
      if (!removable) return { ...answer, keepUntil: until };
      return {
        ...answer,
        removable: true as const,
        ...(view.sessionRef === null
          ? {}
          : { session: { provider: view.provider, ref: view.sessionRef } }),
      };
    });
  }
}
