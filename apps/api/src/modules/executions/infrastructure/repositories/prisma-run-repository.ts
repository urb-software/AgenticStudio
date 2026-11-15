import { Prisma } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import {
  ACTIVE_RUN_STATES,
  CLAIMED_RUN_STATES,
  FINAL_RUN_STATES,
  isFinal,
  MAX_ACTIVE_RUNS,
  PROVIDERS,
  type Provider,
  RUN_DELIVERIES,
  RUN_FAILURE_CODES,
  RUN_STATES,
  type Run,
  type RunDeliveryOutcome,
  type RunDeliveryState,
  type RunFailure,
  type RunFailureCode,
  type RunState,
  type RunWorkingCopy,
} from '../../domain/entities/run.js';
import type {
  ClaimedRunChange,
  DeliveryRetryOutcome,
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
  integrationBranch: true,
  delivery: true,
  pullRequestUrl: true,
  pullRequestNumber: true,
  deliveryRequested: true,
  failingChecks: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  failureCode: true,
  failureDetail: true,
  claimedBy: true,
  environmentFileSupplied: true,
  environmentFilePath: true,
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
  integrationBranch: string;
  delivery: string | null;
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
  deliveryRequested: boolean;
  failingChecks: Prisma.JsonValue;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  failureCode: string | null;
  failureDetail: string | null;
  claimedBy: string | null;
  environmentFileSupplied: boolean;
  environmentFilePath: string | null;
}

const ACTIVE = Prisma.join([...ACTIVE_RUN_STATES]);

/** The columns of a delivery outcome (Issue #102). */
function deliveryColumns(delivery: RunDeliveryOutcome) {
  return {
    delivery: delivery.outcome satisfies RunDeliveryState,
    pullRequestUrl: delivery.outcome === 'delivered' ? delivery.pullRequest.url : null,
    pullRequestNumber: delivery.outcome === 'delivered' ? delivery.pullRequest.number : null,
  };
}

function workingCopyColumns(workingCopy: RunWorkingCopy | null | undefined) {
  return workingCopy
    ? {
        runBranch: workingCopy.runBranch,
        commits: workingCopy.commits as unknown as Prisma.InputJsonValue,
        hasUncommittedChanges: workingCopy.hasUncommittedChanges,
      }
    : {};
}

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
  if (row.delivery !== null && !includes(RUN_DELIVERIES, row.delivery)) {
    throw new Error(`Unexpected run delivery in the database: ${row.delivery}`);
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
    integrationBranch: row.integrationBranch,
    delivery: row.delivery as RunDeliveryState | null,
    // The CHECK constraint sets the URL and the number together.
    pullRequest:
      row.pullRequestUrl === null || row.pullRequestNumber === null
        ? null
        : { url: row.pullRequestUrl, number: row.pullRequestNumber },
    deliveryRequested: row.deliveryRequested,
    failingChecks: Array.isArray(row.failingChecks)
      ? row.failingChecks.filter((name): name is string => typeof name === 'string')
      : [],
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    failure:
      code === null ? null : { code: code as RunFailureCode, detail: row.failureDetail ?? '' },
    claimedBy: row.claimedBy,
    environmentFileSupplied: row.environmentFileSupplied,
    environmentFilePath: row.environmentFilePath,
  };
}

/**
 * PostgreSQL adapter of {@link RunRepository} (Issue #96). Claims run in one transaction
 * under a transaction-scoped advisory lock, so concurrent claims are serialized and each sees
 * the others' committed result: together they cannot exceed one active Run per project or
 * `MAX_ACTIVE_RUNS` across the server; a `failed` Run a worker holds for a delivery retry
 * (Issue #102) counts as active. The partial unique index on active Runs per project backs the
 * first limit in the schema itself.
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
        // Active: an active state, or a failed Run held for a delivery retry (Issue #102).
        const [next] = await tx.$queryRaw<{ id: string; state: string }[]>`
          SELECT r.id, r.state FROM runs r
          WHERE (r.state = 'queued'
                 OR (r.state = 'failed' AND r.delivery_requested AND r.claimed_by IS NULL
                     AND r.last_claimed_by = ${workerId}::uuid))
            AND (SELECT count(*) FROM runs a
                 WHERE a.state IN (${ACTIVE})
                    OR (a.state = 'failed' AND a.claimed_by IS NOT NULL)) < ${MAX_ACTIVE_RUNS}::int
            AND NOT EXISTS (SELECT 1 FROM runs a
                            WHERE a.project_id = r.project_id
                              AND (a.state IN (${ACTIVE})
                                   OR (a.state = 'failed' AND a.claimed_by IS NOT NULL)))
          ORDER BY r.created_at, r.id
          LIMIT 1`;
        if (!next) return null;
        const row =
          next.state === 'queued'
            ? await tx.run.update({
                where: { id: next.id, state: 'queued' },
                data: {
                  state: 'preparing',
                  claimedBy: workerId,
                  lastClaimedBy: workerId,
                  startedAt: now,
                  heartbeatAt: now,
                },
                select: RUN_FIELDS,
              })
            : await tx.run.update({
                where: { id: next.id, state: 'failed', deliveryRequested: true, claimedBy: null },
                data: { claimedBy: workerId, heartbeatAt: now },
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
        ...workingCopyColumns(change.workingCopy),
        ...(change.to === 'succeeded' && change.delivery ? deliveryColumns(change.delivery) : {}),
        ...(change.failure?.code === 'delivery_failed' ? { delivery: 'failed' } : {}),
      },
    });
    return count === 1 ? this.findById(change.runId) : null;
  }

  async requestDeliveryRetry(runId: string): Promise<Run | null> {
    await this.db.run.updateMany({
      where: { id: runId, state: 'failed', failureCode: 'delivery_failed' },
      data: { deliveryRequested: true },
    });
    const run = await this.findById(runId);
    return run?.deliveryRequested ? run : null;
  }

  async listPendingDeliveryRetries(): Promise<{ runId: string; startedBy: string | null }[]> {
    const rows = await this.db.run.findMany({
      where: { state: 'failed', deliveryRequested: true, claimedBy: null },
      select: { id: true, lastClaimedBy: true },
    });
    return rows.map((row) => ({ runId: row.id, startedBy: row.lastClaimedBy }));
  }

  async abandonDeliveryRetry(runId: string, failure: RunFailure, now: Date): Promise<boolean> {
    const { count } = await this.db.run.updateMany({
      where: { id: runId, state: 'failed', deliveryRequested: true, claimedBy: null },
      data: {
        failureCode: failure.code,
        failureDetail: failure.detail,
        delivery: 'failed',
        deliveryRequested: false,
        finishedAt: now,
      },
    });
    return count === 1;
  }

  async finishDeliveryRetry(outcome: DeliveryRetryOutcome): Promise<Run | null> {
    const { result } = outcome;
    const { count } = await this.db.run.updateMany({
      where: {
        id: outcome.runId,
        state: 'failed',
        deliveryRequested: true,
        claimedBy: outcome.workerId,
      },
      data: {
        claimedBy: null,
        heartbeatAt: null,
        deliveryRequested: false,
        finishedAt: outcome.now,
        ...workingCopyColumns(outcome.workingCopy),
        ...(result.state === 'succeeded'
          ? {
              state: 'succeeded',
              failureCode: null,
              failureDetail: null,
              ...deliveryColumns(result.delivery),
            }
          : {
              failureCode: result.failure.code,
              failureDetail: result.failure.detail,
              delivery: 'failed',
            }),
      },
    });
    return count === 1 ? this.findById(outcome.runId) : null;
  }

  async heartbeat(runId: string, workerId: string, now: Date): Promise<boolean> {
    // Held: preparing or running, or failed during a delivery retry (the CHECK constraint
    // allows a holder in no other state).
    const { count } = await this.db.run.updateMany({
      where: { id: runId, claimedBy: workerId },
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
    failingChecks: readonly string[],
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
      // The latest Working copy state (Issue #98) and failing checks (Issue #102), under the
      // same row lock as the step.
      await tx.run.update({
        where: { id: runId },
        data: {
          ...workingCopyColumns(workingCopy),
          failingChecks: [...failingChecks],
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

  async failStaleClaims(
    staleBefore: Date,
    failure: RunFailure,
    deliveryFailure: RunFailure,
    now: Date,
  ): Promise<number> {
    return this.db.$transaction(async (tx) => {
      const held = await tx.run.updateMany({
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
      // A delivery retry whose worker was lost (Issue #102): still a failed delivery.
      const retries = await tx.run.updateMany({
        where: { state: 'failed', claimedBy: { not: null }, heartbeatAt: { lt: staleBefore } },
        data: {
          failureCode: deliveryFailure.code,
          failureDetail: deliveryFailure.detail,
          delivery: 'failed',
          deliveryRequested: false,
          claimedBy: null,
          heartbeatAt: null,
          finishedAt: now,
        },
      });
      return held.count + retries.count;
    });
  }

  async attachEnvironmentFile(
    runId: string,
    workerId: string,
    file: { path: string; secretRef: string },
  ): Promise<boolean> {
    const { count } = await this.db.run.updateMany({
      where: { id: runId, state: 'preparing', claimedBy: workerId },
      data: {
        environmentFileSupplied: true,
        environmentFilePath: file.path,
        environmentFileSecretId: file.secretRef,
      },
    });
    return count === 1;
  }

  async findEnvironmentFileSecret(runId: string): Promise<string | null> {
    const row = await this.db.run.findUnique({
      where: { id: runId },
      select: { environmentFileSecretId: true },
    });
    return row?.environmentFileSecretId ?? null;
  }

  async listFinalEnvironmentFileSecrets(): Promise<{ runId: string; secretRef: string }[]> {
    const rows = await this.db.run.findMany({
      where: { state: { in: [...FINAL_RUN_STATES] }, environmentFileSecretId: { not: null } },
      select: { id: true, environmentFileSecretId: true },
    });
    return rows.map((row) => ({ runId: row.id, secretRef: row.environmentFileSecretId! }));
  }

  async clearEnvironmentFileSecret(runId: string, secretRef: string): Promise<void> {
    await this.db.run.updateMany({
      where: { id: runId, environmentFileSecretId: secretRef },
      data: { environmentFileSecretId: null },
    });
  }

  async listEnvironmentFileSecretRefs(): Promise<string[]> {
    const rows = await this.db.run.findMany({
      where: { environmentFileSecretId: { not: null } },
      select: { environmentFileSecretId: true },
    });
    return rows.map((row) => row.environmentFileSecretId!);
  }
}
