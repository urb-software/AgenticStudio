import { isUniqueConstraintViolation, Prisma } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE_CLIENT } from '../../../../platform/database/database.module.js';
import { PreviewOperation } from '../../domain/entities/preview-operation.js';
import {
  PreviewBuildRunningError,
  PreviewBusyError,
} from '../../domain/errors/preview-settings-errors.js';
import type {
  PreviewDisconnectReadModel,
  PreviewOccupation,
  PreviewReadModel,
  PreviewOperationRepository,
  PreviewRequestFacts,
} from '../../domain/repositories/preview-operation-repository.js';
import { StateCheckRule } from '../../domain/value-objects/state-check-rule.js';
import { OverdueBuildRule } from '../../domain/value-objects/overdue-build-rule.js';
import type { UnclaimedOperationRule } from '../../domain/value-objects/unclaimed-operation-rule.js';
import {
  PREVIEW_FAILURE_CODES,
  type PreviewFailureCode,
} from '../../domain/value-objects/preview-failure-code.js';
import type { LostControllerRule } from '../../domain/value-objects/lost-controller-rule.js';
import { PREVIEW_OPERATION_KINDS } from '../../domain/value-objects/preview-operation-kind.js';
import { isPreviewOperationId } from '../../domain/value-objects/preview-operation-id.js';
import type { PreviewRefusalFacts } from '../../domain/value-objects/preview-refusal-facts.js';
import type { PreviewOperationResultData } from '../../domain/value-objects/preview-operation-result.js';
import { PREVIEW_OPERATION_STATUSES } from '../../domain/value-objects/preview-operation-status.js';
import { type Executor, inTransaction } from './executor.js';

/** The operations that change what runs, as `PreviewRunningRule.changesRunning` selects them. */
const CHANGES_RUNNING = Prisma.sql`(
  (status = 'succeeded' AND (kind IN ('build', 'stop', 'remove_data')
    OR (kind = 'state' AND preview_removed)))
  OR (status = 'failed' AND kind = 'build' AND preview_removed))`;

const ACTIVE_BUILD_INDEX = 'preview_operations_one_active_build_per_project';

/** The serialisation point of claims: a transaction-scoped advisory lock, released at commit. */
const CLAIM_LOCK = 'studio.environments.claim';

/** The serialisation point of operator requests: one transaction-scoped advisory lock. */
const REQUEST_LOCK = 'studio.environments.requests';

/** PostgreSQL adapter of {@link PreviewOperationRepository}: `preview_operations`. */
@Injectable()
export class PrismaPreviewOperationRepository implements PreviewOperationRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: Executor) {}

  async add(operation: PreviewOperation): Promise<void> {
    await insert(this.db, operation);
  }

  async request(
    projectId: string,
    decide: (facts: PreviewRequestFacts) => PreviewOperation[],
  ): Promise<PreviewOperation[]> {
    return inTransaction(this.db, async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${REQUEST_LOCK}))`;
      const preview = await readFacts(tx, projectId);
      const occupying = await readOccupying(tx);
      const operations = decide({ preview, occupying });
      for (const operation of operations) await insert(tx, operation);
      return operations;
    });
  }

  async findPreviewFacts(projectId: string): Promise<PreviewReadModel> {
    return readFacts(this.db, projectId);
  }

  async findOccupyingProjects(): Promise<PreviewOccupation[]> {
    return readOccupying(this.db);
  }

  async findStateCheckProjects(): Promise<string[]> {
    const codes = Prisma.join([...StateCheckRule.UNCERTAIN_FAILURES]);
    const rows = await this.db.$queryRaw<{ project_id: string }[]>`
      SELECT n.project_id::text AS project_id FROM (
        SELECT DISTINCT ON (project_id) project_id, kind, status, claimed_at, failure_code
        FROM preview_operations
        ORDER BY project_id, requested_at DESC, id DESC) n
      WHERE n.kind = 'build' AND n.status = 'failed' AND n.claimed_at IS NOT NULL
        AND n.failure_code IN (${codes})
      ORDER BY n.project_id`;
    return rows.map((row) => row.project_id);
  }

  async findDisconnectFacts(projectId: string): Promise<PreviewDisconnectReadModel> {
    return readDisconnectFacts(this.db, projectId);
  }

  async deleteForDisconnect(
    projectId: string,
    mayDelete: (facts: PreviewDisconnectReadModel) => boolean,
  ): Promise<boolean> {
    return inTransaction(this.db, async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${CLAIM_LOCK}))`;
      if (!mayDelete(await readDisconnectFacts(tx, projectId))) return false;
      await tx.previewOperation.deleteMany({ where: { projectId } });
      return true;
    });
  }

  async findMergeBuild(
    projectId: string,
    runId: string,
    commit: string,
  ): Promise<PreviewOperation | null> {
    const row = await this.db.previewOperation.findFirst({
      where: {
        projectId,
        kind: 'build',
        OR: [{ startedByRunId: runId }, { commit }],
      },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    });
    return row === null ? null : toOperation(row);
  }

  async find(id: string): Promise<PreviewOperation | null> {
    return findOperation(this.db, id);
  }

  async change(
    id: string,
    mutate: (operation: PreviewOperation) => void,
  ): Promise<PreviewOperation | null> {
    if (!isPreviewOperationId(id)) return null;
    return inTransaction(this.db, async (tx) => {
      // Locks the row until commit: what `mutate` decides from the operation holds until saved.
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM preview_operations WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked) return null;
      const operation = toOperation(await tx.previewOperation.findUniqueOrThrow({ where: { id } }));
      mutate(operation);
      await save(tx, operation);
      return toOperation(await tx.previewOperation.findUniqueOrThrow({ where: { id } }));
    });
  }

  async failLost(rule: LostControllerRule, now: Date): Promise<string[]> {
    const failure = rule.failure.toData();
    const rows = await this.db.$queryRaw<{ environment_file_secret_id: string | null }[]>`
      WITH lost AS (
        SELECT id, environment_file_secret_id FROM preview_operations
        WHERE status = 'claimed' AND heartbeat_at < ${rule.staleBefore}::timestamptz
        FOR UPDATE)
      UPDATE preview_operations o
      SET status = 'failed', failure_code = ${failure.code}, failure_detail = ${failure.detail},
          finished_at = ${now}::timestamptz, heartbeat_at = NULL,
          environment_file_secret_id = NULL, environment_file_path = NULL
      FROM lost WHERE o.id = lost.id
      RETURNING lost.environment_file_secret_id`;
    return rows.flatMap((row) =>
      row.environment_file_secret_id === null ? [] : [row.environment_file_secret_id],
    );
  }

  async failOverdue(rule: OverdueBuildRule, now: Date): Promise<string[]> {
    const failure = rule.failure.toData();
    const margin = OverdueBuildRule.MARGIN_MINUTES;
    const rows = await this.db.$queryRaw<{ environment_file_secret_id: string | null }[]>`
      WITH overdue AS (
        SELECT id, environment_file_secret_id FROM preview_operations
        WHERE status = 'claimed' AND kind = 'build'
          AND claimed_at + make_interval(mins => build_minutes + ${margin}::int)
              < ${rule.now}::timestamptz
        FOR UPDATE)
      UPDATE preview_operations o
      SET status = 'failed', failure_code = ${failure.code}, failure_detail = ${failure.detail},
          finished_at = ${now}::timestamptz, heartbeat_at = NULL,
          environment_file_secret_id = NULL, environment_file_path = NULL
      FROM overdue WHERE o.id = overdue.id
      RETURNING overdue.environment_file_secret_id`;
    return rows.flatMap((row) =>
      row.environment_file_secret_id === null ? [] : [row.environment_file_secret_id],
    );
  }

  async failUnclaimed(rule: UnclaimedOperationRule, now: Date): Promise<number> {
    const failure = rule.failure.toData();
    return this.db.$executeRaw`
      UPDATE preview_operations
      SET status = 'failed', failure_code = ${failure.code}, failure_detail = ${failure.detail},
          finished_at = ${now}::timestamptz
      WHERE status = 'requested' AND requested_at < ${rule.requestedBefore}::timestamptz`;
  }

  async claimNext(controllerId: string, now: Date): Promise<PreviewOperation | null> {
    try {
      return await inTransaction(this.db, async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${CLAIM_LOCK}))`;
        const [selected] = await tx.$queryRaw<{ id: string }[]>`
          SELECT o.id FROM preview_operations o
          WHERE o.status = 'requested'
            AND NOT EXISTS (SELECT 1 FROM preview_operations c
                            WHERE c.project_id = o.project_id AND c.status = 'claimed')
          ORDER BY o.requested_at, o.id
          LIMIT 1
          FOR UPDATE OF o SKIP LOCKED`;
        if (!selected) return null;
        const operation = toOperation(
          await tx.previewOperation.findUniqueOrThrow({ where: { id: selected.id } }),
        );
        operation.claim(controllerId, now);
        await save(tx, operation);
        return operation;
      });
    } catch (error) {
      // Backstop: the partial unique index on a claimed Project.
      if (isUniqueConstraintViolation(error)) return null;
      throw error;
    }
  }

  async findEnvironmentFileSecret(id: string): Promise<string | null> {
    if (!isPreviewOperationId(id)) return null;
    const row = await this.db.previewOperation.findUnique({
      where: { id },
      select: { environmentFileSecretId: true },
    });
    return row?.environmentFileSecretId ?? null;
  }

  async listEnvironmentFileSecrets(): Promise<string[]> {
    const rows = await this.db.previewOperation.findMany({
      where: { environmentFileSecretId: { not: null } },
      select: { environmentFileSecretId: true },
    });
    return rows.flatMap((row) =>
      row.environmentFileSecretId === null ? [] : [row.environmentFileSecretId],
    );
  }
}

async function readDisconnectFacts(
  db: Executor,
  projectId: string,
): Promise<PreviewDisconnectReadModel> {
  const active = { projectId, status: { in: ['requested', 'claimed'] } };
  const operations = await db.previewOperation.count({ where: { projectId } });
  const claimedBuilds = await db.previewOperation.count({
    where: { projectId, kind: 'build', claimedAt: { not: null } },
  });
  const newest = await db.previewOperation.findFirst({
    where: { projectId },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    select: { kind: true, status: true },
  });
  const activeOperations = await db.previewOperation.count({ where: active });
  const activeRemovals = await db.previewOperation.count({
    where: { ...active, kind: 'remove_data' },
  });
  return {
    operations,
    buildEverClaimed: claimedBuilds > 0,
    newest,
    activeOperations,
    removalActive: activeRemovals > 0,
  };
}

async function findOperation(db: Executor, id: string): Promise<PreviewOperation | null> {
  if (!isPreviewOperationId(id)) return null;
  const row = await db.previewOperation.findUnique({ where: { id } });
  return row === null ? null : toOperation(row);
}

async function readFacts(db: Executor, projectId: string): Promise<PreviewReadModel> {
  const [latestBuild, latestChange] = await Promise.all([
    db.previewOperation.findFirst({
      where: { projectId, kind: 'build' },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    }),
    db.previewOperation.findFirst({
      where: { projectId, kind: { in: ['stop', 'remove_data'] } },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    }),
  ]);
  // The statement of PreviewRunningRule.changesRunning, newest finish first.
  const [change] = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM preview_operations
    WHERE project_id = ${projectId}::uuid AND ${CHANGES_RUNNING}
    ORDER BY finished_at DESC, id DESC
    LIMIT 1`;
  return {
    latestBuild: latestBuild === null ? null : toOperation(latestBuild),
    runningChange: change ? await findOperation(db, change.id) : null,
    latestChange: latestChange === null ? null : toOperation(latestChange),
  };
}

/** The statement of PreviewRunningLimitRule: a running Preview or an active build. */
async function readOccupying(db: Executor): Promise<PreviewOccupation[]> {
  const rows = await db.$queryRaw<{ project_id: string; state: 'building' | 'running' }[]>`
    WITH latest AS (
      SELECT DISTINCT ON (project_id) project_id, kind, status
      FROM preview_operations
      WHERE ${CHANGES_RUNNING}
      ORDER BY project_id, finished_at DESC, id DESC),
    active AS (
      SELECT DISTINCT project_id FROM preview_operations
      WHERE kind = 'build' AND status IN ('requested', 'claimed'))
    SELECT p.project_id::text AS project_id,
           CASE WHEN p.project_id IN (SELECT project_id FROM active)
                THEN 'building' ELSE 'running' END AS state
    FROM (SELECT project_id FROM active
          UNION
          SELECT project_id FROM latest WHERE kind = 'build' AND status = 'succeeded') p
    ORDER BY p.project_id`;
  return rows.map((row) => ({ projectId: row.project_id, state: row.state }));
}

async function insert(db: Executor, operation: PreviewOperation): Promise<void> {
  const data = operation.toData();
  try {
    await db.previewOperation.create({
      data: {
        id: data.id,
        projectId: data.projectId,
        kind: data.kind,
        status: data.status,
        requestedAt: data.requestedAt,
        ...(data.build === null
          ? {}
          : {
              commit: data.build.commit,
              composeFile: data.build.composeFile,
              service: data.build.service,
              port: data.build.port,
              memoryMiB: data.build.limits.memoryMiB,
              cpuPercent: data.build.limits.cpuPercent,
              tasksMax: data.build.limits.tasksMax,
              buildMinutes: data.build.limits.buildMinutes,
              startedByRunId: data.build.startedByRunId,
            }),
      },
    });
  } catch (error) {
    if (data.kind === 'build' && isActiveBuildViolation(error)) {
      throw new PreviewBuildRunningError();
    }
    if (
      (data.kind === 'stop' || data.kind === 'remove_data') &&
      isUniqueConstraintViolation(error)
    ) {
      throw new PreviewBusyError();
    }
    throw error;
  }
}

/** The partial unique index; a violation that names another constraint is not this one. */
function isActiveBuildViolation(error: unknown): boolean {
  if (!isUniqueConstraintViolation(error)) return false;
  const named = JSON.stringify((error as { meta?: unknown }).meta ?? '');
  return named.includes(ACTIVE_BUILD_INDEX) || !named.includes('preview_operations_');
}

async function save(tx: Prisma.TransactionClient, operation: PreviewOperation): Promise<void> {
  const data = operation.toData();
  await tx.previewOperation.update({
    where: { id: data.id },
    data: {
      status: data.status,
      claimedBy: data.claimedBy,
      claimedAt: data.claimedAt,
      heartbeatAt: data.heartbeatAt,
      finishedAt: data.finishedAt,
      failureCode: data.failure?.code ?? null,
      failureDetail: data.failure?.detail ?? null,
      previewRemoved: data.previewRemoved,
      refusals:
        data.failure !== null && data.failure.refusals.length > 0
          ? (data.failure.refusals as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
      result:
        data.result === null ? Prisma.DbNull : (data.result as unknown as Prisma.InputJsonValue),
      environmentFilePath: data.environmentFile?.path ?? null,
      environmentFileSecretId: data.environmentFile?.secretId ?? null,
    },
  });
}

function toOperation(row: Prisma.PreviewOperationGetPayload<object>): PreviewOperation {
  if (!(PREVIEW_OPERATION_KINDS as readonly string[]).includes(row.kind)) {
    throw new Error(`Unexpected Preview operation kind in the database: ${row.kind}`);
  }
  if (!(PREVIEW_OPERATION_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`Unexpected Preview operation status in the database: ${row.status}`);
  }
  const build =
    row.kind === 'build'
      ? {
          commit: row.commit!,
          composeFile: row.composeFile!,
          service: row.service!,
          port: row.port!,
          limits: {
            memoryMiB: row.memoryMiB!,
            cpuPercent: row.cpuPercent!,
            tasksMax: row.tasksMax!,
            buildMinutes: row.buildMinutes!,
          },
          startedByRunId: row.startedByRunId,
        }
      : null;
  if (
    row.failureCode !== null &&
    !(PREVIEW_FAILURE_CODES as readonly string[]).includes(row.failureCode)
  ) {
    throw new Error(`Unexpected Preview failure code in the database: ${row.failureCode}`);
  }
  return PreviewOperation.restore({
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as (typeof PREVIEW_OPERATION_KINDS)[number],
    status: row.status as (typeof PREVIEW_OPERATION_STATUSES)[number],
    build,
    requestedAt: row.requestedAt,
    claimedBy: row.claimedBy,
    claimedAt: row.claimedAt,
    heartbeatAt: row.heartbeatAt,
    finishedAt: row.finishedAt,
    failure:
      row.failureCode === null
        ? null
        : {
            code: row.failureCode as PreviewFailureCode,
            detail: row.failureDetail ?? '',
            refusals: (row.refusals ?? []) as unknown as PreviewRefusalFacts[],
          },
    previewRemoved: row.previewRemoved,
    log: { bytes: row.logBytes, truncated: row.logTruncated },
    result: row.result === null ? null : (row.result as unknown as PreviewOperationResultData),
    environmentFile:
      row.environmentFileSecretId === null
        ? null
        : { path: row.environmentFilePath ?? '', secretId: row.environmentFileSecretId },
  });
}
