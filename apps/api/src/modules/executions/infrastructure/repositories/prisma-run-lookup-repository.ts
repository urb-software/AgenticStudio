import { Prisma } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE_CLIENT } from '../../../../platform/database/database.module.js';
import { RunLookup } from '../../domain/entities/run-lookup.js';
import type { RunLookupRepository } from '../../domain/repositories/run-lookup-repository.js';
import type { LookupHandOutRule } from '../../domain/value-objects/lookup-hand-out-rule.js';
import {
  REVIEW_COMMENT_SCOPES,
  type ReviewCommentScope,
  type ReviewCommentsLoad,
} from '../../domain/value-objects/review-comments.js';
import {
  type ClaimedLookup,
  LOOKUP_KINDS,
  LOOKUP_STATUSES,
  type LookupKind,
  type LookupStatus,
} from '../../domain/value-objects/run-lookup.js';
import { type Executor, inTransaction } from './executor.js';

const OPEN = ['requested', 'claimed'];

/**
 * PostgreSQL adapter of {@link RunLookupRepository} (Issue #142): one `run_lookups` row per
 * request, at most one open (requested or claimed) per Run and kind (a partial unique index backs
 * the check). It writes only that table; the claim joins the Run's row, read-only, for what the
 * worker needs to answer. Claims skip rows another claim holds.
 */
@Injectable()
export class PrismaRunLookupRepository implements RunLookupRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: Executor) {}

  async add(lookup: RunLookup): Promise<void> {
    await this.db.runLookup.create({
      data: {
        id: lookup.id,
        runId: lookup.runId,
        kind: lookup.kind,
        status: lookup.status,
        requestedAt: lookup.requestedAt,
        ...(lookup.scope === null ? {} : { scope: lookup.scope, since: lookup.since }),
      },
    });
  }

  async save(lookup: RunLookup): Promise<void> {
    await this.db.runLookup.update({
      where: { id: lookup.id },
      data: {
        status: lookup.status,
        claimedBy: lookup.claimedBy,
        claimedAt: lookup.claimedAt,
        retryAt: lookup.retryAt,
        finishedAt: lookup.finishedAt,
        error: lookup.error,
        result:
          lookup.result === null || lookup.result === undefined
            ? Prisma.DbNull
            : (lookup.result as Prisma.InputJsonValue),
      },
    });
  }

  async findById(id: string): Promise<RunLookup | null> {
    const row = await this.db.runLookup.findUnique({ where: { id } });
    return row === null ? null : toLookup(row);
  }

  async findOpen(runId: string, kind: LookupKind): Promise<RunLookup | null> {
    const row = await this.db.runLookup.findFirst({
      where: { runId, kind, status: { in: OPEN } },
    });
    return row === null ? null : toLookup(row);
  }

  async claim(workerId: string, rule: LookupHandOutRule): Promise<ClaimedLookup[]> {
    return inTransaction(this.db, async (tx) => {
      // A worker that never answered loses its claim: the lookup is handed out again.
      await tx.$executeRaw`
        UPDATE run_lookups SET status = 'requested', claimed_by = NULL, claimed_at = NULL
        WHERE status = 'claimed'
          AND claimed_at <= ${rule.now}::timestamptz - make_interval(secs => ${rule.leaseSeconds})`;
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
          AND (l.retry_at IS NULL OR l.retry_at <= ${rule.now}::timestamptz)
          AND r.pull_request_number IS NOT NULL AND r.run_branch IS NOT NULL
        ORDER BY l.requested_at, l.id
        LIMIT ${rule.limit}
        FOR UPDATE OF l SKIP LOCKED`;
      if (rows.length === 0) return [];
      await tx.runLookup.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { status: 'claimed', claimedBy: workerId, claimedAt: rule.now, retryAt: null },
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

  async deleteFinishedBefore(before: Date): Promise<number> {
    const { count } = await this.db.runLookup.deleteMany({
      where: { status: { in: ['done', 'failed'] }, finishedAt: { lt: before } },
    });
    return count;
  }

  async findReviewCommentsLoad(runId: string): Promise<ReviewCommentsLoad> {
    const [open, latest] = await Promise.all([
      this.db.runLookup.findFirst({
        where: { runId, kind: 'review_comments', status: { in: OPEN } },
        select: { error: true },
      }),
      this.db.runLookup.findFirst({
        where: { runId, kind: 'review_comments' },
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        select: { status: true, error: true },
      }),
    ]);
    return {
      loading: open !== null,
      error: open?.error ?? (latest?.status === 'failed' ? latest.error : null),
    };
  }
}

/** A stored lookup as the aggregate; the CHECK constraints fix its kind, status and scope. */
function toLookup(row: {
  id: string;
  runId: string;
  kind: string;
  status: string;
  requestedAt: Date;
  claimedBy: string | null;
  claimedAt: Date | null;
  retryAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  result: Prisma.JsonValue | null;
  scope: string | null;
  since: Date | null;
}): RunLookup {
  if (!(LOOKUP_KINDS as readonly string[]).includes(row.kind)) {
    throw new Error(`Unexpected lookup kind in the database: ${row.kind}`);
  }
  if (!(LOOKUP_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`Unexpected lookup status in the database: ${row.status}`);
  }
  return RunLookup.restore({
    id: row.id,
    runId: row.runId,
    kind: row.kind as LookupKind,
    status: row.status as LookupStatus,
    requestedAt: row.requestedAt,
    claimedBy: row.claimedBy,
    claimedAt: row.claimedAt,
    retryAt: row.retryAt,
    finishedAt: row.finishedAt,
    error: row.error,
    result: row.result,
    scope: row.scope === null ? null : reviewCommentsOf(row.scope, null).scope,
    since: row.since,
  });
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
