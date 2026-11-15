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
  RUN_FAILURE_CODES,
  RUN_STATES,
  type Run,
  type RunFailure,
  type RunFailureCode,
  type RunState,
  type RunWorkingCopy,
} from '../../domain/entities/run.js';
import type {
  ClaimedRunChange,
  NewRun,
  RunRepository,
  RunStateView,
  RunStepRecord,
  StoredRunStep,
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
    const row = await this.db.run.create({
      data: { ...run, state: 'queued' },
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
    const { count } = await this.db.run.updateMany({
      where: { id: change.runId, state: change.from, claimedBy: change.workerId },
      data: {
        state: change.to,
        failureCode: change.failure?.code ?? null,
        failureDetail: change.failure?.detail ?? null,
        claimedBy: held ? change.workerId : null,
        heartbeatAt: held ? change.now : null,
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

  async heartbeat(runId: string, workerId: string, now: Date): Promise<boolean> {
    const { count } = await this.db.run.updateMany({
      where: { id: runId, claimedBy: workerId, state: { in: [...CLAIMED_RUN_STATES] } },
      data: { heartbeatAt: now },
    });
    return count === 1;
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
  ): Promise<number | null> {
    return this.db.$transaction(async (tx) => {
      // Locks the Run row: the check and the numbering hold until the step is stored.
      const [run] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM runs
        WHERE id = ${runId}::uuid AND state = 'running' AND claimed_by = ${workerId}::uuid
        FOR UPDATE`;
      if (!run) return null;
      const last = await tx.runStep.aggregate({ where: { runId }, _max: { index: true } });
      const index = (last._max.index ?? 0) + 1;
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
      return index;
    });
  }

  async listSteps(runId: string): Promise<StoredRunStep[]> {
    const rows = await this.db.runStep.findMany({
      where: { runId },
      orderBy: { index: 'asc' },
      select: { index: true, kind: true, result: true, createdAt: true },
    });
    return rows.map((row) => {
      if (row.kind !== 'start' && row.kind !== 'resume') {
        throw new Error(`Unexpected run step kind in the database: ${row.kind}`);
      }
      return { index: row.index, kind: row.kind, result: row.result, reportedAt: row.createdAt };
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
