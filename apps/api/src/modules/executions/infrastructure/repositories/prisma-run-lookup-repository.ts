import { Prisma } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import type { PreparedFollowUp } from '../../domain/entities/prepared-follow-up.js';
import {
  isPullRequestEnded,
  type PullRequestState,
  type RunPullRequestChecks,
} from '../../domain/entities/run.js';
import {
  REVIEW_COMMENT_SCOPES,
  type ReviewCommentScope,
  type ReviewCommentsRequest,
} from '../../domain/entities/review-comments.js';
import {
  type ClaimedLookup,
  LOOKUP_KINDS,
  type LookupKind,
  type PullRequestStateResult,
  type ReviewCommentsResult,
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
  return isPullRequestEnded(state)
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

  async request(
    runId: string,
    kind: LookupKind,
    now: Date,
    review?: ReviewCommentsRequest,
  ): Promise<LookupRequestOutcome> {
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
        data: {
          runId,
          kind,
          status: 'requested',
          requestedAt: now,
          ...(review === undefined ? {} : { scope: review.scope, since: review.since }),
        },
      });
      // A load of Review comments marks no column of the Run: its state is read from the lookups.
      if (kind !== 'review_comments') {
        await tx.run.update({
          where: { id: runId },
          data: requestedColumns(kind, now),
        });
      }
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
          scope: string | null;
          since: Date | null;
        }[]
      >`
        SELECT l.id, l.kind, l.run_id, r.remote_url, r.pull_request_number, r.run_branch,
               r.integration_branch, l.scope, l.since
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
          ...(row.kind === 'review_comments'
            ? { reviewComments: reviewCommentsOf(row.scope, row.since) }
            : {}),
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
          pr_checks = ${checksJson(result)}::jsonb,
          ${prEndedAtAssignment(result.state, now)}
        WHERE id = ${lookup.runId}::uuid AND pull_request_number IS NOT NULL`;
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

  async completeReviewComments(
    lookupId: string,
    workerId: string,
    result: ReviewCommentsResult,
    now: Date,
  ): Promise<LookupAnswerOutcome> {
    return this.db.$transaction(async (tx) => {
      const lookup = await tx.runLookup.findUnique({ where: { id: lookupId } });
      if (!lookup || lookup.claimedBy !== workerId) return 'not_held';
      if (lookup.status === 'done') return 'duplicate';
      if (lookup.status !== 'claimed') return 'not_held';
      const scope = reviewCommentsOf(lookup.scope, lookup.since).scope;
      await tx.runLookup.update({
        where: { id: lookupId },
        data: {
          status: 'done',
          finishedAt: now,
          // The comments are kept in the Run's set only, not twice.
          result: { comments: result.comments.length, truncated: result.truncated },
          error: null,
          retryAt: null,
        },
      });
      // The latest load replaces the earlier one.
      const comments = result.comments as unknown as Prisma.InputJsonValue;
      await tx.runReviewCommentSet.upsert({
        where: { runId: lookup.runId },
        create: {
          runId: lookup.runId,
          scope,
          comments,
          truncated: result.truncated,
          loadedAt: now,
        },
        update: { scope, comments, truncated: result.truncated, loadedAt: now },
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
      // A failed load of Review comments marks no column of the Run: the error stays on the lookup.
      if (lookup.kind !== 'review_comments') {
        await tx.run.updateMany({
          where: { id: lookup.runId },
          data: failedColumns(lookup.kind as LookupKind, error, retryAt, lookup.requestedAt),
        });
      }
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
    // Review N1 of #152: what an ended pull request cannot have is cleared with the state (a closed
    // one keeps its branch position); nothing is cleared for a draft or open one.
    await this.db.$executeRaw`
      UPDATE runs SET
        pr_state = ${state},
        pr_refreshed_at = ${now}::timestamptz,
        pr_refresh_error = NULL,
        pr_retry_at = NULL,
        pr_behind_by = CASE WHEN ${state} IN ('merged', 'missing') THEN NULL ELSE pr_behind_by END,
        pr_ahead_by = CASE WHEN ${state} IN ('merged', 'missing') THEN NULL ELSE pr_ahead_by END,
        pr_mergeable = CASE WHEN ${state} IN ('merged', 'missing', 'closed') THEN NULL ELSE pr_mergeable END,
        pr_checks = CASE WHEN ${state} IN ('merged', 'missing', 'closed') THEN NULL ELSE pr_checks END,
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

/** What a stored `review_comments` lookup asks for; the CHECK constraint fixes its scope. */
function reviewCommentsOf(
  scope: string | null,
  since: Date | null,
): { scope: ReviewCommentScope; since?: Date } {
  if (!(REVIEW_COMMENT_SCOPES as readonly (string | null)[]).includes(scope)) {
    throw new Error(`Unexpected review comment scope in the database: ${String(scope)}`);
  }
  return { scope: scope as ReviewCommentScope, ...(since === null ? {} : { since }) };
}

/**
 * The `pr_checks` value for a state result (Issue #145), as JSON text for a `::jsonb` cast: the
 * checks and their commit, the marker that the Git host would not tell, or `null` when the
 * result has no checks.
 */
function checksJson(result: PullRequestStateResult): string | null {
  const value: RunPullRequestChecks | null =
    result.checksUnavailable === true
      ? { unavailable: true }
      : result.checks !== undefined && result.checksCommit !== undefined
        ? { commit: result.checksCommit, checks: result.checks }
        : null;
  return value === null ? null : JSON.stringify(value);
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
