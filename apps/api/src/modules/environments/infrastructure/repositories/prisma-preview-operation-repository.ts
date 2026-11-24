import { isUniqueConstraintViolation, Prisma } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE_CLIENT } from '../../../../platform/database/database.module.js';
import { PreviewOperation } from '../../domain/entities/preview-operation.js';
import { PreviewBuildRunningError } from '../../domain/errors/preview-settings-errors.js';
import type {
  PreviewReadModel,
  PreviewOperationRepository,
} from '../../domain/repositories/preview-operation-repository.js';
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

const ACTIVE_BUILD_INDEX = 'preview_operations_one_active_build_per_project';

/** The serialisation point of claims: a transaction-scoped advisory lock, released at commit. */
const CLAIM_LOCK = 'studio.environments.claim';

/** PostgreSQL adapter of {@link PreviewOperationRepository}: `preview_operations`. */
@Injectable()
export class PrismaPreviewOperationRepository implements PreviewOperationRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: Executor) {}

  async add(operation: PreviewOperation): Promise<void> {
    const data = operation.toData();
    try {
      await this.insert(data);
    } catch (error) {
      if (data.kind === 'build' && isActiveBuildViolation(error)) {
        throw new PreviewBuildRunningError();
      }
      throw error;
    }
  }

  async findPreviewFacts(projectId: string): Promise<PreviewReadModel> {
    const latest = await this.db.previewOperation.findFirst({
      where: { projectId, kind: 'build' },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    });
    // The statement of PreviewRunningRule.changesRunning, newest finish first.
    const [change] = await this.db.$queryRaw<{ id: string }[]>`
      SELECT id FROM preview_operations
      WHERE project_id = ${projectId}::uuid
        AND ((status = 'succeeded' AND kind IN ('build', 'stop', 'remove_data'))
          OR (status = 'failed' AND kind = 'build' AND preview_removed))
      ORDER BY finished_at DESC, id DESC
      LIMIT 1`;
    return {
      latestBuild: latest === null ? null : toOperation(latest),
      runningChange: change ? await this.find(change.id) : null,
    };
  }

  private async insert(data: ReturnType<PreviewOperation['toData']>): Promise<void> {
    await this.db.previewOperation.create({
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
            }),
      },
    });
  }

  async find(id: string): Promise<PreviewOperation | null> {
    if (!isPreviewOperationId(id)) return null;
    const row = await this.db.previewOperation.findUnique({ where: { id } });
    return row === null ? null : toOperation(row);
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
