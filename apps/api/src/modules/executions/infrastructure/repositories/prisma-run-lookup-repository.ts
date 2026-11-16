import { Prisma } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import type { PullRequestState } from '../../domain/entities/run.js';
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
 * The `pr_ended_at` assignment of a Run whose pull request was read as `state` (Issue #143): the
 * first time it is read as merged, closed or missing is kept (the retention period counts from
 * it); reading it open or draft again (a reopened pull request) clears it.
 */
function prEndedAtAssignment(state: PullRequestState, now: Date): Prisma.Sql {
  const ended = state === 'merged' || state === 'closed' || state === 'missing';
  return ended
    ? Prisma.sql`pr_ended_at = COALESCE(pr_ended_at, ${now}::timestamptz)`
    : Prisma.sql`pr_ended_at = NULL`;
}

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
        data: { prRefreshRequestedAt: now, prLastAttemptAt: now },
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
      await tx.$executeRaw`
        UPDATE runs SET
          pr_state = ${result.state},
          pr_behind_by = ${result.behindBy ?? null}::int,
          pr_ahead_by = ${result.aheadBy ?? null}::int,
          pr_mergeable = ${result.mergeable ?? null}::boolean,
          pr_refreshed_at = ${now}::timestamptz,
          pr_refresh_error = NULL,
          pr_retry_at = NULL,
          pr_refresh_requested_at = NULL,
          ${prEndedAtAssignment(result.state, now)}
        WHERE id = ${lookup.runId}::uuid AND pull_request_number IS NOT NULL`;
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
        data: {
          prRefreshError: error,
          prRetryAt: retryAt,
          // Still being refreshed while the lookup waits for its retry.
          prRefreshRequestedAt: retryAt === null ? null : lookup.requestedAt,
        },
      });
      return 'stored';
    });
  }

  async findKind(lookupId: string): Promise<LookupKind | null> {
    const lookup = await this.db.runLookup.findUnique({
      where: { id: lookupId },
      select: { kind: true },
    });
    return lookup === null ? null : (lookup.kind as LookupKind);
  }

  async recordObservedState(runId: string, state: PullRequestState, now: Date): Promise<void> {
    await this.db.$executeRaw`
      UPDATE runs SET
        pr_state = ${state},
        pr_refreshed_at = ${now}::timestamptz,
        pr_refresh_error = NULL,
        pr_retry_at = NULL,
        ${prEndedAtAssignment(state, now)}
      WHERE id = ${runId}::uuid AND pull_request_number IS NOT NULL`;
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
