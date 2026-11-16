import { Prisma } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import type { PreparedFollowUp } from '../../domain/entities/prepared-follow-up.js';
import type { PullRequestState, RunPullRequestChecks } from '../../domain/entities/run.js';
import {
  type ClaimedLookup,
  LOOKUP_KINDS,
  type LookupKind,
  type PullRequestStateResult,
} from '../../domain/entities/run-lookup.js';
import type {
  LookupAnswerOutcome,
  LookupRequestOutcome,
  RunLookupRepository,
} from '../../domain/repositories/run-lookup-repository.js';

const OPEN = ['requested', 'claimed'];

/**
 * PostgreSQL adapter of {@link RunLookupRepository} (Issue #142): one `run_lookups` row per
 * request, at most one open (requested or claimed) per Run and kind (a partial unique index
 * backs the check), and the Run's `pr_*` columns updated in the same transaction as the answer.
 * A request locks the Run's row, so two requests at once record one; claims skip rows another
 * claim holds.
 */
@Injectable()
export class PrismaRunLookupRepository implements RunLookupRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  async request(runId: string, kind: LookupKind, now: Date): Promise<LookupRequestOutcome> {
    return this.db.$transaction(async (tx) => {
      const [run] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM runs
        WHERE id = ${runId}::uuid AND pull_request_number IS NOT NULL AND run_branch IS NOT NULL
        FOR UPDATE`;
      if (!run) return 'not_possible';
      const open = await tx.runLookup.findFirst({
        where: { runId, kind, status: { in: OPEN } },
        select: { id: true },
      });
      if (open) return 'open';
      await tx.runLookup.create({
        data: { runId, kind, status: 'requested', requestedAt: now },
      });
      await tx.run.update({
        where: { id: runId },
        data: requestedColumns(kind, now),
      });
      return 'requested';
    });
  }

  async claim(
    workerId: string,
    now: Date,
    limit: number,
    leaseSeconds: number,
  ): Promise<ClaimedLookup[]> {
    return this.db.$transaction(async (tx) => {
      // A worker that never answered loses its claim: the lookup is handed out again.
      await tx.$executeRaw`
        UPDATE run_lookups SET status = 'requested', claimed_by = NULL, claimed_at = NULL
        WHERE status = 'claimed'
          AND claimed_at <= ${now}::timestamptz - make_interval(secs => ${leaseSeconds})`;
      const rows = await tx.$queryRaw<
        {
          id: string;
          kind: string;
          run_id: string;
          remote_url: string;
          pull_request_number: number;
          run_branch: string;
          integration_branch: string;
        }[]
      >`
        SELECT l.id, l.kind, l.run_id, r.remote_url, r.pull_request_number, r.run_branch,
               r.integration_branch
        FROM run_lookups l
        JOIN runs r ON r.id = l.run_id
        WHERE l.status = 'requested'
          AND (l.retry_at IS NULL OR l.retry_at <= ${now}::timestamptz)
          AND r.pull_request_number IS NOT NULL AND r.run_branch IS NOT NULL
        ORDER BY l.requested_at, l.id
        LIMIT ${limit}
        FOR UPDATE OF l SKIP LOCKED`;
      if (rows.length === 0) return [];
      await tx.runLookup.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { status: 'claimed', claimedBy: workerId, claimedAt: now, retryAt: null },
      });
      return rows.map((row) => {
        if (!(LOOKUP_KINDS as readonly string[]).includes(row.kind)) {
          throw new Error(`Unexpected lookup kind in the database: ${row.kind}`);
        }
        return {
          id: row.id,
          kind: row.kind as LookupKind,
          runId: row.run_id,
          remoteUrl: row.remote_url,
          pullRequestNumber: row.pull_request_number,
          runBranch: row.run_branch,
          integrationBranch: row.integration_branch,
        };
      });
    });
  }

  async completePullRequestState(
    lookupId: string,
    workerId: string,
    result: PullRequestStateResult,
    now: Date,
  ): Promise<LookupAnswerOutcome> {
    return this.db.$transaction(async (tx) => {
      const lookup = await tx.runLookup.findUnique({ where: { id: lookupId } });
      if (!lookup || lookup.claimedBy !== workerId) return 'not_held';
      if (lookup.status === 'done') return 'duplicate';
      if (lookup.status !== 'claimed') return 'not_held';
      await tx.runLookup.update({
        where: { id: lookupId },
        data: {
          status: 'done',
          finishedAt: now,
          result: result as unknown as Prisma.InputJsonValue,
          error: null,
          retryAt: null,
        },
      });
      // A Run's state is what the latest answer says; the counts and the merge verdict are
      // cleared when the answer has none (a merged, closed or missing pull request).
      await tx.run.updateMany({
        where: { id: lookup.runId, pullRequestNumber: { not: null } },
        data: {
          prState: result.state,
          prBehindBy: result.behindBy ?? null,
          prAheadBy: result.aheadBy ?? null,
          prMergeable: result.mergeable ?? null,
          prRefreshedAt: now,
          prRefreshError: null,
          prRetryAt: null,
          prRefreshRequestedAt: null,
          prChecks: checksColumn(result),
        },
      });
      return 'stored';
    });
  }

  async completeFailingCheckLogs(
    lookupId: string,
    workerId: string,
    draft: PreparedFollowUp,
    now: Date,
  ): Promise<LookupAnswerOutcome> {
    return this.db.$transaction(async (tx) => {
      const lookup = await tx.runLookup.findUnique({ where: { id: lookupId } });
      if (!lookup || lookup.claimedBy !== workerId) return 'not_held';
      if (lookup.status === 'done') return 'duplicate';
      if (lookup.status !== 'claimed') return 'not_held';
      await tx.runLookup.update({
        where: { id: lookupId },
        data: {
          status: 'done',
          finishedAt: now,
          // The text is kept in the prepared Follow-up only, not twice.
          result: { items: draft.items.length },
          error: null,
          retryAt: null,
        },
      });
      // The latest preparation replaces the earlier one.
      await tx.runPreparedFollowUp.upsert({
        where: { runId: lookup.runId },
        create: {
          runId: lookup.runId,
          source: draft.source,
          text: draft.text,
          items: draft.items as unknown as Prisma.InputJsonValue,
          createdAt: now,
        },
        update: {
          source: draft.source,
          text: draft.text,
          items: draft.items as unknown as Prisma.InputJsonValue,
          createdAt: now,
        },
      });
      await tx.run.updateMany({
        where: { id: lookup.runId },
        data: { prPrepareRequestedAt: null, prPrepareError: null },
      });
      return 'stored';
    });
  }

  async fail(
    lookupId: string,
    workerId: string,
    error: string,
    retryInSeconds: number | null,
    now: Date,
  ): Promise<LookupAnswerOutcome> {
    return this.db.$transaction(async (tx) => {
      const lookup = await tx.runLookup.findUnique({ where: { id: lookupId } });
      if (!lookup) return 'not_held';
      // A re-sent rate-limit answer (the lookup waits for its retry with this very error).
      if (lookup.status === 'requested' && lookup.retryAt !== null && lookup.error === error) {
        return 'duplicate';
      }
      if (lookup.claimedBy !== workerId) return 'not_held';
      if (lookup.status === 'failed') return 'duplicate';
      if (lookup.status !== 'claimed') return 'not_held';
      const retryAt =
        retryInSeconds === null ? null : new Date(now.getTime() + retryInSeconds * 1000);
      await tx.runLookup.update({
        where: { id: lookupId },
        data:
          retryAt === null
            ? { status: 'failed', finishedAt: now, error }
            : { status: 'requested', claimedBy: null, claimedAt: null, retryAt, error },
      });
      await tx.run.updateMany({
        where: { id: lookup.runId },
        data: failedColumns(lookup.kind as LookupKind, error, retryAt, lookup.requestedAt),
      });
      return 'stored';
    });
  }

  async findRef(lookupId: string): Promise<{ kind: LookupKind; runId: string } | null> {
    const lookup = await this.db.runLookup.findUnique({
      where: { id: lookupId },
      select: { kind: true, runId: true },
    });
    return lookup === null ? null : { kind: lookup.kind as LookupKind, runId: lookup.runId };
  }

  async recordObservedState(runId: string, state: PullRequestState, now: Date): Promise<void> {
    await this.db.run.updateMany({
      where: { id: runId, pullRequestNumber: { not: null } },
      data: {
        prState: state,
        prRefreshedAt: now,
        prRefreshError: null,
        prRetryAt: null,
        // Review N1 of #152: what an ended pull request cannot have is cleared with the state.
        ...(state === 'merged' || state === 'missing'
          ? { prBehindBy: null, prAheadBy: null, prMergeable: null }
          : {}),
        ...(state === 'closed' ? { prMergeable: null } : {}),
        ...(state === 'merged' || state === 'missing' || state === 'closed'
          ? { prChecks: Prisma.DbNull }
          : {}),
      },
    });
  }

  async deleteFinishedBefore(before: Date): Promise<number> {
    const { count } = await this.db.runLookup.deleteMany({
      where: { status: { in: ['done', 'failed'] }, finishedAt: { lt: before } },
    });
    return count;
  }

  async listDueForDailyRefresh(attemptedBefore: Date, limit: number): Promise<string[]> {
    const rows = await this.db.run.findMany({
      where: {
        pullRequestNumber: { not: null },
        runBranch: { not: null },
        prRefreshRequestedAt: null,
        AND: [
          { OR: [{ prState: null }, { prState: { in: ['draft', 'open'] } }] },
          {
            OR: [
              { prLastAttemptAt: { lt: attemptedBefore } },
              {
                prLastAttemptAt: null,
                OR: [{ prRefreshedAt: null }, { prRefreshedAt: { lt: attemptedBefore } }],
              },
            ],
          },
        ],
      },
      orderBy: [{ prLastAttemptAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      select: { id: true },
      take: limit,
    });
    return rows.map((row) => row.id);
  }
}

/**
 * The `pr_checks` column for a state result (Issue #145): the checks and their commit, the
 * marker that the Git host would not tell, or nothing (null) when the result has no checks.
 */
function checksColumn(
  result: PullRequestStateResult,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const value: RunPullRequestChecks | null =
    result.checksUnavailable === true
      ? { unavailable: true }
      : result.checks !== undefined && result.checksCommit !== undefined
        ? { commit: result.checksCommit, checks: result.checks }
        : null;
  return value === null ? Prisma.DbNull : (value as unknown as Prisma.InputJsonValue);
}

/**
 * The Run's columns a new request of `kind` sets (Issue #145: reading the failing checks' logs is
 * not a refresh of the state: it only marks the Run as preparing, and leaves the page-open
 * throttle alone).
 */
function requestedColumns(kind: LookupKind, now: Date): Prisma.RunUpdateInput {
  return kind === 'failing_check_logs'
    ? { prPrepareRequestedAt: now, prPrepareError: null }
    : { prRefreshRequestedAt: now, prLastAttemptAt: now };
}

/**
 * The Run's columns a failed lookup of `kind` sets: the error, and with a retry (`retryAt`) the
 * Run stays refreshing or preparing until it.
 */
function failedColumns(
  kind: LookupKind,
  error: string,
  retryAt: Date | null,
  requestedAt: Date,
): Prisma.RunUpdateManyMutationInput {
  const waiting = retryAt === null ? null : requestedAt;
  return kind === 'failing_check_logs'
    ? { prPrepareError: error, prPrepareRequestedAt: waiting }
    : { prRefreshError: error, prRetryAt: retryAt, prRefreshRequestedAt: waiting };
}
