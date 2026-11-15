import { Prisma } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import {
  ACTIVE_RUN_STATES,
  CLAIMED_RUN_STATES,
  isFinal,
  MAX_ACTIVE_RUNS,
  PROVIDERS,
  type Provider,
  RUN_CANCELLED_BY,
  RUN_FAILURE_CODES,
  RUN_STATES,
  type Run,
  type RunCancellation,
  type RunCancelledBy,
  type RunFailure,
  type RunFailureCode,
  type RunState,
  type RunWorkingCopy,
  stepLimitFailure,
} from '../../domain/entities/run.js';
import type {
  AppendStepOutcome,
  ClaimedRunChange,
  NewRun,
  RunRepository,
  RunStateView,
  RunStepRecord,
} from '../../domain/repositories/run-repository.js';

const RUN_FIELDS = {
  id: true,
  projectId: true,
  provider: true,
  task: true,
  state: true,
  startCommit: true,
  remoteUrl: true,
  runBranch: true,
  commits: true,
  hasUncommittedChanges: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  failureCode: true,
  failureDetail: true,
  claimedBy: true,
  cancelRequestedAt: true,
  cancelledBy: true,
  cancelReason: true,
  waitingSince: true,
  limitStepMinutes: true,
  limitMaxSteps: true,
  limitWaitingDays: true,
} as const;

interface RunRow {
  id: string;
  projectId: string;
  provider: string;
  task: string;
  state: string;
  startCommit: string;
  remoteUrl: string;
  runBranch: string | null;
  commits: Prisma.JsonValue;
  hasUncommittedChanges: boolean | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  failureCode: string | null;
  failureDetail: string | null;
  claimedBy: string | null;
  cancelRequestedAt: Date | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  waitingSince: Date | null;
  limitStepMinutes: number;
  limitMaxSteps: number;
  limitWaitingDays: number;
}

const ACTIVE = Prisma.join([...ACTIVE_RUN_STATES]);

/** Generous limits: concurrent claims wait for the claim lock inside their transactions. */
const CLAIM_TRANSACTION = { maxWait: 10_000, timeout: 15_000 } as const;

const NEWEST_FIRST = [{ createdAt: 'desc' }, { id: 'desc' }] as const;

const includes = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

/** Maps a row; the CHECK constraints guarantee the state and the failure fields agree. */
function toRun(row: RunRow): Run {
  if (!includes(RUN_STATES, row.state)) {
    throw new Error(`Unexpected run state in the database: ${row.state}`);
  }
  if (!includes(PROVIDERS, row.provider)) {
    throw new Error(`Unexpected run provider in the database: ${row.provider}`);
  }
  const code = row.failureCode;
  if (code !== null && !includes(RUN_FAILURE_CODES, code)) {
    throw new Error(`Unexpected run failure code in the database: ${code}`);
  }
  const by = row.cancelledBy;
  if (by !== null && !includes(RUN_CANCELLED_BY, by)) {
    throw new Error(`Unexpected run cancellation in the database: ${by}`);
  }
  return {
    id: row.id,
    projectId: row.projectId,
    provider: row.provider as Provider,
    task: row.task,
    state: row.state as RunState,
    startCommit: row.startCommit,
    remoteUrl: row.remoteUrl,
    workingCopy:
      row.runBranch === null
        ? null
        : {
            runBranch: row.runBranch,
            // Validated by the worker protocol when reported; stored as reported.
            commits: row.commits as unknown as RunWorkingCopy['commits'],
            hasUncommittedChanges: row.hasUncommittedChanges ?? false,
          },
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    failure:
      code === null ? null : { code: code as RunFailureCode, detail: row.failureDetail ?? '' },
    claimedBy: row.claimedBy,
    limits: {
      stepMinutes: row.limitStepMinutes,
      maxSteps: row.limitMaxSteps,
      waitingDays: row.limitWaitingDays,
    },
    cancelRequestedAt: row.cancelRequestedAt,
    cancellation: by === null ? null : { by: by as RunCancelledBy, reason: row.cancelReason ?? '' },
    waitingSince: row.waitingSince,
  };
}

/**
 * PostgreSQL adapter of {@link RunRepository} (Issue #96). Claims run in one transaction
 * under a transaction-scoped advisory lock, so concurrent claims are serialized and each sees
 * the others' committed result: together they cannot exceed one active Run per project or
 * `MAX_ACTIVE_RUNS` across the server. The partial unique index on active Runs per project
 * backs the first limit in the schema itself.
 */
@Injectable()
export class PrismaRunRepository implements RunRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  async add(run: NewRun): Promise<Run> {
    const { limits, ...fields } = run;
    const row = await this.db.run.create({
      data: {
        ...fields,
        state: 'queued',
        limitStepMinutes: limits.stepMinutes,
        limitMaxSteps: limits.maxSteps,
        limitWaitingDays: limits.waitingDays,
      },
      select: RUN_FIELDS,
    });
    return toRun(row);
  }

  async findById(id: string): Promise<Run | null> {
    const row = await this.db.run.findUnique({ where: { id }, select: RUN_FIELDS });
    return row ? toRun(row) : null;
  }

  async listNewestFirst(): Promise<Run[]> {
    const rows = await this.db.run.findMany({ orderBy: [...NEWEST_FIRST], select: RUN_FIELDS });
    return rows.map(toRun);
  }

  async listByProjectNewestFirst(projectId: string): Promise<Run[]> {
    const rows = await this.db.run.findMany({
      where: { projectId },
      orderBy: [...NEWEST_FIRST],
      select: RUN_FIELDS,
    });
    return rows.map(toRun);
  }

  async claimNext(workerId: string, now: Date): Promise<Run | null> {
    return this.db.$transaction(
      async (tx) => {
        // Serializes claims (released at commit or rollback); other writers are not blocked.
        await tx.$queryRaw`
          SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('studio.executions.claim'))`;
        const [next] = await tx.$queryRaw<{ id: string }[]>`
          SELECT r.id FROM runs r
          WHERE r.state = 'queued'
            AND (SELECT count(*) FROM runs a
                 WHERE a.state IN (${ACTIVE})) < ${MAX_ACTIVE_RUNS}::int
            AND NOT EXISTS (SELECT 1 FROM runs a
                            WHERE a.project_id = r.project_id
                              AND a.state IN (${ACTIVE}))
          ORDER BY r.created_at, r.id
          LIMIT 1`;
        if (!next) return null;
        const row = await tx.run.update({
          where: { id: next.id, state: 'queued' },
          data: { state: 'preparing', claimedBy: workerId, startedAt: now, heartbeatAt: now },
          select: RUN_FIELDS,
        });
        return toRun(row);
      },
      // Claims queue on the lock inside their transactions; each holds it for milliseconds.
      CLAIM_TRANSACTION,
    );
  }

  async transitionClaimed(change: ClaimedRunChange): Promise<Run | null> {
    const held = includes(CLAIMED_RUN_STATES, change.to);
    const cancellation = change.to === 'cancelled' ? (change.cancellation ?? null) : null;
    const { count } = await this.db.run.updateMany({
      where: {
        id: change.runId,
        state: change.from,
        claimedBy: change.workerId,
        cancelRequestedAt: change.cancelRequested ? { not: null } : null,
      },
      data: {
        state: change.to,
        failureCode: change.failure?.code ?? null,
        failureDetail: change.failure?.detail ?? null,
        claimedBy: held ? change.workerId : null,
        heartbeatAt: held ? change.now : null,
        cancelledBy: cancellation?.by ?? null,
        cancelReason: cancellation?.reason ?? null,
        waitingSince: change.to === 'waiting_for_operator' ? change.now : null,
        ...(isFinal(change.to) ? { finishedAt: change.now } : {}),
        ...(change.workingCopy
          ? {
              runBranch: change.workingCopy.runBranch,
              commits: change.workingCopy.commits as unknown as Prisma.InputJsonValue,
              hasUncommittedChanges: change.workingCopy.hasUncommittedChanges,
            }
          : {}),
      },
    });
    return count === 1 ? this.findById(change.runId) : null;
  }

  async heartbeat(
    runId: string,
    workerId: string,
    now: Date,
  ): Promise<{ cancelRequested: boolean } | null> {
    // One statement: the renewal and the cancel request it answers with are read together.
    const [row] = await this.db.$queryRaw<{ cancel_requested: boolean }[]>`
      UPDATE runs SET heartbeat_at = ${now}
      WHERE id = ${runId}::uuid AND claimed_by = ${workerId}::uuid
        AND state IN (${Prisma.join([...CLAIMED_RUN_STATES])})
      RETURNING cancel_requested_at IS NOT NULL AS cancel_requested`;
    return row ? { cancelRequested: row.cancel_requested } : null;
  }

  async cancelUnheld(
    runId: string,
    from: 'queued' | 'waiting_for_operator',
    cancellation: RunCancellation,
    now: Date,
  ): Promise<Run | null> {
    const { count } = await this.db.run.updateMany({
      where: { id: runId, state: from },
      data: {
        state: 'cancelled',
        cancelledBy: cancellation.by,
        cancelReason: cancellation.reason,
        waitingSince: null,
        finishedAt: now,
      },
    });
    return count === 1 ? this.findById(runId) : null;
  }

  async requestCancel(runId: string, now: Date): Promise<Run | null> {
    // The first request's time is kept: a repeated cancel changes nothing.
    await this.db.run.updateMany({
      where: { id: runId, state: { in: [...CLAIMED_RUN_STATES] }, cancelRequestedAt: null },
      data: { cancelRequestedAt: now },
    });
    const run = await this.findById(runId);
    return run && includes(CLAIMED_RUN_STATES, run.state) && run.cancelRequestedAt ? run : null;
  }

  async listWaiting(): Promise<Run[]> {
    const rows = await this.db.run.findMany({
      where: { state: 'waiting_for_operator' },
      orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      select: RUN_FIELDS,
    });
    return rows.map(toRun);
  }

  async renewClaims(now: Date): Promise<number> {
    const { count } = await this.db.run.updateMany({
      where: { state: { in: [...CLAIMED_RUN_STATES] } },
      data: { heartbeatAt: now },
    });
    return count;
  }

  async findStates(ids: readonly string[]): Promise<RunStateView[]> {
    const rows = await this.db.run.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, state: true, finishedAt: true },
    });
    return rows.map((row) => {
      if (!includes(RUN_STATES, row.state)) {
        throw new Error(`Unexpected run state in the database: ${row.state}`);
      }
      return { runId: row.id, state: row.state, finishedAt: row.finishedAt };
    });
  }

  async appendStep(
    runId: string,
    workerId: string,
    step: RunStepRecord,
    workingCopy: RunWorkingCopy,
    now: Date,
  ): Promise<AppendStepOutcome> {
    return this.db.$transaction(async (tx): Promise<AppendStepOutcome> => {
      // Locks the Run row: the check and the numbering hold until the step is stored.
      const [run] = await tx.$queryRaw<{ id: string; limit_max_steps: number }[]>`
        SELECT id, limit_max_steps FROM runs
        WHERE id = ${runId}::uuid AND state = 'running' AND claimed_by = ${workerId}::uuid
        FOR UPDATE`;
      if (!run) return { status: 'not_held' };
      const last = await tx.runStep.aggregate({ where: { runId }, _max: { index: true } });
      const index = (last._max.index ?? 0) + 1;
      if (index > run.limit_max_steps) {
        // Issue #100: the step is not stored, and the Run fails under the same row lock.
        const failure = stepLimitFailure(run.limit_max_steps);
        await tx.run.update({
          where: { id: runId },
          data: {
            state: 'failed',
            failureCode: failure.code,
            failureDetail: failure.detail,
            claimedBy: null,
            heartbeatAt: null,
            finishedAt: now,
          },
        });
        return { status: 'step_limit' };
      }
      await tx.runStep.create({
        data: { runId, index, kind: step.kind, result: step.result as Prisma.InputJsonValue },
      });
      // The latest Working copy state (Issue #98), under the same row lock as the step.
      await tx.run.update({
        where: { id: runId },
        data: {
          runBranch: workingCopy.runBranch,
          commits: workingCopy.commits as unknown as Prisma.InputJsonValue,
          hasUncommittedChanges: workingCopy.hasUncommittedChanges,
        },
      });
      return { status: 'stored', index };
    });
  }

  async failStaleClaims(staleBefore: Date, failure: RunFailure, now: Date): Promise<number> {
    const { count } = await this.db.run.updateMany({
      where: { state: { in: [...CLAIMED_RUN_STATES] }, heartbeatAt: { lt: staleBefore } },
      data: {
        state: 'failed',
        failureCode: failure.code,
        failureDetail: failure.detail,
        claimedBy: null,
        heartbeatAt: null,
        finishedAt: now,
      },
    });
    return count;
  }
}
