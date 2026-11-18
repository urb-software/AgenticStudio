import { Inject, Injectable } from '@nestjs/common';
import {
  RUN_REPOSITORY,
  type RunRepository,
  type RunStateView,
} from '../../../domain/repositories/run-repository.js';
import type { Provider } from '../../../domain/value-objects/provider.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RETENTION_POLICY, type RetentionPolicy } from '../../ports/retention-policy.js';

export interface RunRetentionAnswer {
  runId: string;
  state: RunStateView['state'];
  finishedAt: Date | null;
  keepUntil?: Date;
  removable?: true;
  session?: { provider: Provider; ref: string };
}

export interface GetRunStatesInput {
  runIds: readonly string[];
  removed?: { workerId: string; runIds: readonly string[] };
}

export type GetRunStatesResult = RunRetentionAnswer[];

/**
 * Ids that name no Run are left out, so the worker removes their directories. An unknown pull
 * request state counts as open, so a Git host outage removes nothing.
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
    // Each Run is changed under its own row lock: a Follow-up queued meanwhile
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
