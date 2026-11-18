import { isUniqueConstraintViolation, Prisma } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE_CLIENT } from '../../../../platform/database/database.module.js';
import { type Executor, inTransaction } from './executor.js';
import {
  CLAIMED_RUN_STATES,
  FINAL_RUN_STATES,
  RUN_STATES,
  type RunState,
  UNDER_WAY_RUN_STATES,
} from '../../domain/value-objects/run-state.js';
import { PROVIDERS, type Provider } from '../../domain/value-objects/provider.js';
import {
  RUN_CANCELLED_BY,
  type RunCancelledBy,
} from '../../domain/value-objects/run-cancelled-by.js';
import { type RunCancellation } from '../../domain/value-objects/run-cancellation.js';
import {
  RUN_FAILURE_CODES,
  type RunFailureCode,
} from '../../domain/value-objects/run-failure-code.js';
import { type RunFailure } from '../../domain/value-objects/run-failure.js';
import { isRunId } from '../../domain/value-objects/run-id.js';
import { type ResumeFacts } from '../../domain/entities/run-resume-facts.js';
import { type RunChanges } from '../../domain/entities/run-change-facts.js';
import { Run } from '../../domain/entities/run.js';
import { type RunSnapshot } from '../../domain/entities/run-snapshot.js';
import { RunSlotTakenError } from '../../domain/errors/run-errors.js';
import { RUN_DELIVERIES, type RunDeliveryState } from '../../domain/value-objects/run-delivery.js';
import { type RunMessage, type RunPartEnd } from '../../domain/value-objects/run-conversation.js';
import {
  type RunPullRequestChecks,
  type PullRequestState,
} from '../../domain/value-objects/run-pull-request-status.js';
import { type RunWorkingCopy } from '../../domain/value-objects/run-working-copy.js';
import type { FollowUpSource } from '../../domain/value-objects/follow-up-source.js';
import { HandOutRule } from '../../domain/value-objects/hand-out-rule.js';
import type { RunStepSnapshot } from '../../domain/entities/run-step-snapshot.js';
import type {
  LimitedRunView,
  RunRepository,
  RunsSummary,
  RunStateView,
} from '../../domain/repositories/run-repository.js';

const LIST_FIELDS = {
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
  heartbeatAt: true,
  environmentFileSupplied: true,
  environmentFilePath: true,
  cancelRequestedAt: true,
  cancelledBy: true,
  cancelReason: true,
  waitingSince: true,
  limitStepMinutes: true,
  limitMaxSteps: true,
  limitWaitingDays: true,
  stepStartedAt: true,
  releasedBy: true,
  sessionRef: true,
  lastClaimedBy: true,
  followUpCount: true,
  followUpQueued: true,
  stepsBeforePart: true,
  limitMaxTotalSteps: true,
  pushedCommit: true,
  workingCopyRemovedAt: true,
  prState: true,
  prBehindBy: true,
  prAheadBy: true,
  prMergeable: true,
  prRefreshedAt: true,
  prRefreshError: true,
  prRetryAt: true,
  prRefreshRequestedAt: true,
  prLastAttemptAt: true,
  prChecks: true,
  prPrepareRequestedAt: true,
  prPrepareError: true,
  prEndedAt: true,
  lastActivityAt: true,
  _count: { select: { steps: true } },
} as const;

const RUN_FIELDS = {
  ...LIST_FIELDS,
  messages: {
    select: {
      kind: true,
      text: true,
      options: true,
      recommendation: true,
      at: true,
      endState: true,
      endFailureCode: true,
      endDelivery: true,
      source: true,
      sourceCount: true,
      sourceAuthors: true,
      mergedCommit: true,
      updateBase: true,
      updateTip: true,
    },
    orderBy: { seq: 'asc' },
  },
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
  heartbeatAt: Date | null;
  environmentFileSupplied: boolean;
  environmentFilePath: string | null;
  cancelRequestedAt: Date | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  waitingSince: Date | null;
  limitStepMinutes: number;
  limitMaxSteps: number;
  limitWaitingDays: number;
  stepStartedAt: Date | null;
  releasedBy: string | null;
  sessionRef: string | null;
  lastClaimedBy: string | null;
  followUpCount: number;
  followUpQueued: boolean;
  stepsBeforePart: number;
  limitMaxTotalSteps: number;
  pushedCommit: string | null;
  workingCopyRemovedAt: Date | null;
  prState: string | null;
  prBehindBy: number | null;
  prAheadBy: number | null;
  prMergeable: boolean | null;
  prRefreshedAt: Date | null;
  prRefreshError: string | null;
  prRetryAt: Date | null;
  prRefreshRequestedAt: Date | null;
  prLastAttemptAt: Date | null;
  prChecks: Prisma.JsonValue;
  prPrepareRequestedAt: Date | null;
  prPrepareError: string | null;
  prEndedAt: Date | null;
  lastActivityAt: Date;
  _count: { steps: number };
  messages?: {
    kind: string;
    text: string;
    options: Prisma.JsonValue;
    recommendation: string | null;
    at: Date;
    endState: string | null;
    endFailureCode: string | null;
    endDelivery: string | null;
    source: string | null;
    sourceCount: number | null;
    sourceAuthors: string[];
    mergedCommit: string | null;
    updateBase: string | null;
    updateTip: string | null;
  }[];
}

const PLACE_STATES = Prisma.join([...HandOutRule.PLACE_STATES]);

function toMessage(row: NonNullable<RunRow['messages']>[number]): RunMessage {
  if (row.kind === 'answer') return { kind: 'answer', text: row.text, at: row.at };
  if (row.kind === 'follow_up') {
    return {
      kind: 'follow_up',
      text: row.text,
      at: row.at,
      ...(row.source === null ? {} : { source: row.source as FollowUpSource }),
      ...(row.sourceCount === null
        ? {}
        : { sourceComments: { count: row.sourceCount, authors: row.sourceAuthors } }),
      ...(row.mergedCommit === null ? {} : { mergedCommit: row.mergedCommit }),
      ...(row.updateBase === null ? {} : { updateBase: row.updateBase }),
      ...(row.updateTip === null ? {} : { updateTip: row.updateTip }),
    };
  }
  if (row.kind === 'part_end') {
    return {
      kind: 'part_end',
      state: row.endState as RunPartEnd['state'],
      failureCode: row.endFailureCode as RunFailureCode | null,
      delivery: row.endDelivery as RunDeliveryState | null,
      detail: row.text,
      at: row.at,
    };
  }
  if (row.kind !== 'question') {
    throw new Error(`Unexpected run message kind in the database: ${row.kind}`);
  }
  const options = Array.isArray(row.options)
    ? row.options.filter((option): option is string => typeof option === 'string')
    : [];
  return {
    kind: 'question',
    question: {
      text: row.text,
      ...(options.length > 0 ? { options } : {}),
      ...(row.recommendation === null ? {} : { recommendation: row.recommendation }),
    },
    at: row.at,
  };
}

const HOLDS_PLACE = Prisma.sql`(a.state IN (${PLACE_STATES})
  OR (a.state = 'failed' AND a.claimed_by IS NOT NULL)
  OR (a.state = 'queued' AND a.session_ref IS NOT NULL AND NOT a.follow_up_queued))`;

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
  if (row.delivery !== null && !includes(RUN_DELIVERIES, row.delivery)) {
    throw new Error(`Unexpected run delivery in the database: ${row.delivery}`);
  }
  return Run.restore({
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
    heartbeatAt: row.heartbeatAt,
    environmentFileSupplied: row.environmentFileSupplied,
    environmentFilePath: row.environmentFilePath,
    limits: {
      stepMinutes: row.limitStepMinutes,
      maxSteps: row.limitMaxSteps,
      waitingDays: row.limitWaitingDays,
      maxTotalSteps: row.limitMaxTotalSteps,
    },
    cancelRequestedAt: row.cancelRequestedAt,
    cancellation: by === null ? null : { by: by as RunCancelledBy, reason: row.cancelReason ?? '' },
    waitingSince: row.waitingSince,
    stepStartedAt: row.stepStartedAt,
    releasedBy: row.releasedBy,
    sessionRef: row.sessionRef,
    messages: (row.messages ?? []).map(toMessage),
    lastClaimedBy: row.lastClaimedBy,
    stepCount: row._count.steps,
    followUpCount: row.followUpCount,
    followUpQueued: row.followUpQueued,
    stepsBeforePart: row.stepsBeforePart,
    pushedCommit: row.pushedCommit,
    workingCopyRemovedAt: row.workingCopyRemovedAt,
    pullRequestStatus: {
      // The CHECK constraint fixes the state's values.
      state: row.prState as PullRequestState | null,
      behindBy: row.prBehindBy,
      aheadBy: row.prAheadBy,
      mergeable: row.prMergeable,
      refreshedAt: row.prRefreshedAt,
      refreshError: row.prRefreshError,
      retryAt: row.prRetryAt,
      refreshRequestedAt: row.prRefreshRequestedAt,
      lastAttemptAt: row.prLastAttemptAt,
      // Written by the lookups from a validated worker result.
      checks: row.prChecks as RunPullRequestChecks | null,
      prepareRequestedAt: row.prPrepareRequestedAt,
      prepareError: row.prPrepareError,
      endedAt: row.prEndedAt,
    },
    lastActivityAt: row.lastActivityAt,
  });
}

function messageRow(message: RunMessage) {
  switch (message.kind) {
    case 'answer':
      return { kind: 'answer', text: message.text, at: message.at };
    case 'follow_up':
      return {
        kind: 'follow_up',
        text: message.text,
        at: message.at,
        ...(message.source === undefined ? {} : { source: message.source }),
        ...(message.sourceComments === undefined
          ? {}
          : {
              sourceCount: message.sourceComments.count,
              sourceAuthors: message.sourceComments.authors,
            }),
      };
    case 'part_end':
      return {
        kind: 'part_end',
        text: message.detail,
        endState: message.state,
        endFailureCode: message.failureCode,
        endDelivery: message.delivery,
        at: message.at,
      };
    case 'question':
      return {
        kind: 'question',
        text: message.question.text,
        ...(message.question.options ? { options: [...message.question.options] } : {}),
        ...(message.question.recommendation === undefined
          ? {}
          : { recommendation: message.question.recommendation }),
        at: message.at,
      };
  }
}

type ChangedField = keyof RunChanges['fields'];

const CHANGED_COLUMNS: {
  [K in ChangedField]?: (
    value: NonNullable<RunChanges['fields'][K]> | null,
  ) => Prisma.RunUncheckedUpdateInput;
} = {
  state: (state) => ({ state: state! }),
  waitingSince: (waitingSince) => ({ waitingSince }),
  lastActivityAt: (lastActivityAt) => ({ lastActivityAt: lastActivityAt! }),
  finishedAt: (finishedAt) => ({ finishedAt }),
  failure: (failure) => ({
    failureCode: failure?.code ?? null,
    failureDetail: failure?.detail ?? null,
  }),
  cancellation: (cancellation) => ({
    cancelledBy: cancellation?.by ?? null,
    cancelReason: cancellation?.reason ?? null,
  }),
  cancelRequestedAt: (cancelRequestedAt) => ({ cancelRequestedAt }),
  followUpQueued: (followUpQueued) => ({ followUpQueued: followUpQueued! }),
  followUpCount: (followUpCount) => ({ followUpCount: followUpCount! }),
  stepsBeforePart: (stepsBeforePart) => ({ stepsBeforePart: stepsBeforePart! }),
  delivery: (delivery) => ({ delivery }),
  stepStartedAt: (stepStartedAt) => ({ stepStartedAt }),
  deliveryRequested: (deliveryRequested) => ({ deliveryRequested: deliveryRequested! }),
  claimedBy: (claimedBy) => ({ claimedBy }),
  heartbeatAt: (heartbeatAt) => ({ heartbeatAt }),
  releasedBy: (releasedBy) => ({ releasedBy }),
  workingCopy: (workingCopy) => workingCopyColumns(workingCopy),
  pullRequest: (pullRequest) => ({
    pullRequestUrl: pullRequest?.url ?? null,
    pullRequestNumber: pullRequest?.number ?? null,
  }),
  pushedCommit: (pushedCommit) => ({ pushedCommit }),
  failingChecks: (failingChecks) => ({ failingChecks: [...(failingChecks ?? [])] }),
  sessionRef: (sessionRef) => ({ sessionRef }),
  workingCopyRemovedAt: (workingCopyRemovedAt) => ({ workingCopyRemovedAt }),
  environmentFileSupplied: (supplied) => ({ environmentFileSupplied: supplied! }),
  environmentFilePath: (environmentFilePath) => ({ environmentFilePath }),
  pullRequestStatus: (status) => ({
    prState: status!.state,
    prBehindBy: status!.behindBy,
    prAheadBy: status!.aheadBy,
    prMergeable: status!.mergeable,
    prRefreshedAt: status!.refreshedAt,
    prRefreshError: status!.refreshError,
    prRetryAt: status!.retryAt,
    prRefreshRequestedAt: status!.refreshRequestedAt,
    prLastAttemptAt: status!.lastAttemptAt,
    prChecks:
      status!.checks === null
        ? Prisma.DbNull
        : (status!.checks as unknown as Prisma.InputJsonValue),
    prPrepareRequestedAt: status!.prepareRequestedAt,
    prPrepareError: status!.prepareError,
    prEndedAt: status!.endedAt,
  }),
  // Counted from the stored Run steps, not a column.
  stepCount: () => ({}),
};

function changedColumns(fields: RunChanges['fields']): Prisma.RunUncheckedUpdateInput {
  const data: Prisma.RunUncheckedUpdateInput = {};
  for (const [field, value] of Object.entries(fields)) {
    const column = CHANGED_COLUMNS[field as ChangedField] as
      ((value: unknown) => Prisma.RunUncheckedUpdateInput) | undefined;
    if (column === undefined) throw new Error(`The Run field ${field} cannot be saved here.`);
    Object.assign(data, column(value));
  }
  return data;
}

/**
 * Claims run in one transaction under a transaction-scoped advisory lock, so concurrent claims are
 * serialized and see each other's result: together they cannot exceed `HandOutRule.MAX_PLACES`
 * or one active Run per project (the partial unique index backs the latter).
 */
@Injectable()
export class PrismaRunRepository implements RunRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: Executor) {}

  async add(run: Run): Promise<Run> {
    const row = await this.db.run.create({
      data: {
        // The creation time is the database's (ordering by it must not depend on the API's clock).
        id: run.id,
        projectId: run.projectId,
        provider: run.provider,
        task: run.task,
        startCommit: run.startCommit,
        remoteUrl: run.remoteUrl,
        integrationBranch: run.delivery.integrationBranch,
        state: 'queued',
        limitStepMinutes: run.progress.limits.stepMinutes,
        limitMaxSteps: run.progress.limits.maxSteps,
        limitWaitingDays: run.progress.limits.waitingDays,
        limitMaxTotalSteps: run.progress.limits.maxTotalSteps,
      },
      select: RUN_FIELDS,
    });
    return toRun(row);
  }

  async findById(id: string): Promise<Run | null> {
    const row = await this.db.run.findUnique({ where: { id }, select: RUN_FIELDS });
    return row ? toRun(row) : null;
  }

  async exists(id: string): Promise<boolean> {
    if (!isRunId(id)) return false;
    return (await this.db.run.count({ where: { id } })) > 0;
  }

  async listNewestFirst(): Promise<RunSnapshot[]> {
    const rows = await this.db.run.findMany({ orderBy: [...NEWEST_FIRST], select: LIST_FIELDS });
    return rows.map((row) => toRun(row).snapshot());
  }

  async summarize(): Promise<RunsSummary> {
    const groups = await this.db.run.groupBy({
      by: ['state'],
      where: { state: { in: [...UNDER_WAY_RUN_STATES, 'waiting_for_operator'] } },
      _count: { _all: true },
    });
    const count = (states: readonly string[]) =>
      groups
        .filter((group) => states.includes(group.state))
        .reduce((sum, group) => sum + group._count._all, 0);
    return { running: count(UNDER_WAY_RUN_STATES), waiting: count(['waiting_for_operator']) };
  }

  async listByProjectNewestFirst(projectId: string): Promise<RunSnapshot[]> {
    const rows = await this.db.run.findMany({
      where: { projectId },
      orderBy: [...NEWEST_FIRST],
      select: LIST_FIELDS,
    });
    return rows.map((row) => toRun(row).snapshot());
  }

  async claimNext(workerId: string, now: Date): Promise<RunSnapshot | null> {
    return inTransaction(
      this.db,
      async (tx) => {
        // Serializes claims (released at commit or rollback); other writers are not blocked.
        await tx.$queryRaw`
          SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('studio.executions.claim'))`;
        // One statement selects and hands out the Run: it waits for a held row lock and re-checks
        // the row, so a concurrent cancel cannot fail the claim and no Run is skipped for being
        // briefly locked.
        const [claimed] = await tx.$queryRaw<{ id: string }[]>`
          UPDATE runs SET
            state = CASE WHEN state = 'queued' THEN 'preparing' ELSE state END,
            claimed_by = ${workerId}::uuid,
            last_claimed_by = CASE WHEN state = 'queued' THEN ${workerId}::uuid ELSE last_claimed_by END,
            started_at = CASE WHEN state = 'queued' THEN COALESCE(started_at, ${now}) ELSE started_at END,
            heartbeat_at = ${now},
            follow_up_queued = CASE WHEN state = 'queued' THEN false ELSE follow_up_queued END
          WHERE id = (
            SELECT r.id FROM runs r
            WHERE ((r.state = 'queued'
                    AND (r.session_ref IS NULL OR r.last_claimed_by = ${workerId}::uuid))
                   OR (r.state = 'failed' AND r.delivery_requested AND r.claimed_by IS NULL
                       AND r.last_claimed_by = ${workerId}::uuid))
              AND (SELECT count(*) FROM runs a
                   WHERE a.id <> r.id AND ${HOLDS_PLACE}) < ${HandOutRule.MAX_PLACES}::int
              AND NOT EXISTS (SELECT 1 FROM runs a
                              WHERE a.id <> r.id
                                AND a.project_id = r.project_id
                                AND ${HOLDS_PLACE})
            ORDER BY r.created_at, r.id
            LIMIT 1
            FOR UPDATE OF r)
          RETURNING id`;
        if (!claimed) return null;
        return toRun(
          await tx.run.findUniqueOrThrow({ where: { id: claimed.id }, select: RUN_FIELDS }),
        ).snapshot();
      },
      // Claims queue on the lock inside their transactions; each holds it for milliseconds.
      CLAIM_TRANSACTION,
    );
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

  async cancelUnheld(
    runId: string,
    from: 'queued' | 'waiting_for_operator',
    cancellation: RunCancellation,
    now: Date,
  ): Promise<RunSnapshot | null> {
    const { count } = await this.db.run.updateMany({
      where: { id: runId, state: from },
      data: {
        state: 'cancelled',
        cancelledBy: cancellation.by,
        cancelReason: cancellation.reason,
        waitingSince: null,
        finishedAt: now,
        followUpQueued: false,
      },
    });
    return count === 1 ? ((await this.findById(runId))?.snapshot() ?? null) : null;
  }

  async listWaiting(): Promise<RunSnapshot[]> {
    const rows = await this.db.run.findMany({
      where: { state: 'waiting_for_operator' },
      orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      select: LIST_FIELDS,
    });
    return rows.map((row) => toRun(row).snapshot());
  }

  async renewClaimsOncePerLease(now: Date, leaseSeconds: number): Promise<number | null> {
    return inTransaction(this.db, async (tx) => {
      // Records this renewal only if the last one is at least a lease old (or there is none);
      // the row lock serializes two APIs starting at once.
      const renewed = await tx.$queryRaw<{ id: number }[]>`
        INSERT INTO run_lease_renewals (id, renewed_at) VALUES (1, ${now})
        ON CONFLICT (id) DO UPDATE SET renewed_at = EXCLUDED.renewed_at
          WHERE run_lease_renewals.renewed_at <= ${now}::timestamptz - make_interval(secs => ${leaseSeconds})
        RETURNING id`;
      if (renewed.length === 0) return null;
      const { count } = await tx.run.updateMany({
        where: { state: { in: [...CLAIMED_RUN_STATES] } },
        data: { heartbeatAt: now },
      });
      return count;
    });
  }

  async timeOutOverdueSteps(now: Date, graceMinutes: number): Promise<number> {
    return this.db.$executeRaw`
      UPDATE runs
      SET state = 'timed_out', claimed_by = NULL, heartbeat_at = NULL, finished_at = ${now}
      WHERE state = 'running'
        AND step_started_at + make_interval(mins => limit_step_minutes + ${graceMinutes}::int)
            < ${now}::timestamptz`;
  }

  async change(runId: string, mutate: (run: Run) => void): Promise<Run | null> {
    return this.changeLocked(runId, {}, (run) => {
      mutate(run);
    });
  }

  async changeSerializedWithClaims(
    runId: string,
    mutate: (run: Run, facts: ResumeFacts) => void,
  ): Promise<Run | null> {
    try {
      return await this.changeLocked(runId, { serializedWithClaims: true }, async (run, tx) => {
        const [places] = await tx.$queryRaw<{ project: number; server: number }[]>`
          SELECT count(*) FILTER (WHERE a.project_id = ${run.projectId}::uuid)::int AS project,
                 count(*)::int AS server
          FROM runs a
          WHERE a.id <> ${runId}::uuid AND ${HOLDS_PLACE}`;
        const snapshot = await tx.run.findUnique({
          where: { id: runId },
          select: { environmentFileSecretId: true },
        });
        mutate(run, {
          projectPlaceTaken: (places?.project ?? 0) > 0,
          serverPlacesTaken: places?.server ?? 0,
          environmentFileSnapshotKept: snapshot?.environmentFileSecretId != null,
        });
      });
    } catch (error) {
      // Backstop: the partial unique index on a project's active Run.
      if (isUniqueConstraintViolation(error)) throw new RunSlotTakenError('project');
      throw error;
    }
  }

  /**
   * Loads the Run FOR UPDATE, lets `work` change it and saves its pending changes in one
   * transaction. `serializedWithClaims` takes the claim lock first, as a claim does: the lock order
   * is the same everywhere, so claims and this change cannot deadlock.
   */
  private async changeLocked(
    runId: string,
    options: { serializedWithClaims?: boolean },
    work: (run: Run, tx: Prisma.TransactionClient) => void | Promise<void>,
  ): Promise<Run | null> {
    if (!isRunId(runId)) return null;
    return inTransaction(
      this.db,
      async (tx) => {
        if (options.serializedWithClaims) {
          await tx.$queryRaw`
          SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('studio.executions.claim'))`;
        }
        // Locks the Run row until commit: what `work` decides from the Run it then reads holds
        // until the change is saved, and a worker's conditional update waits for it.
        const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM runs WHERE id = ${runId}::uuid FOR UPDATE`;
        if (!locked) return null;
        const read = () => tx.run.findUniqueOrThrow({ where: { id: runId }, select: RUN_FIELDS });
        const run = toRun(await read());
        await work(run, tx);
        await this.persist(tx, run);
        return toRun(await read());
      },
      CLAIM_TRANSACTION,
    );
  }

  async save(run: Run): Promise<void> {
    await inTransaction(this.db, (tx) => this.persist(tx, run));
  }

  private async persist(tx: Prisma.TransactionClient, run: Run): Promise<void> {
    const changes = run.pendingChanges();
    const data = changedColumns(changes.fields);
    if (changes.messages.length > 0) {
      const last = await tx.runMessage.findFirst({
        where: { runId: run.id },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      let seq = last?.seq ?? 0;
      for (const message of changes.messages) {
        await tx.runMessage.create({ data: { runId: run.id, seq: ++seq, ...messageRow(message) } });
      }
    }
    for (const step of changes.steps ?? []) {
      await tx.runStep.create({
        data: {
          runId: run.id,
          index: step.index,
          kind: step.kind,
          result: step.result as Prisma.InputJsonValue,
        },
      });
    }
    if (changes.followUpEntry) {
      const entry = await tx.runMessage.findFirst({
        where: { runId: run.id, kind: 'follow_up' },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      if (entry) {
        const { updateBase, updateTip, mergedCommit } = changes.followUpEntry;
        await tx.runMessage.update({
          where: { runId_seq: { runId: run.id, seq: entry.seq } },
          data: {
            ...(updateBase === undefined ? {} : { updateBase }),
            ...(updateTip === undefined ? {} : { updateTip }),
            ...(mergedCommit === undefined ? {} : { mergedCommit }),
          },
        });
      }
    }
    if (changes.environmentFileSecretRef !== undefined) {
      data.environmentFileSecretId = changes.environmentFileSecretRef;
    }
    if (Object.keys(data).length > 0) await tx.run.update({ where: { id: run.id }, data });
  }

  async listPendingResumes(): Promise<{ runId: string; startedBy: string | null }[]> {
    const rows = await this.db.run.findMany({
      where: { state: 'queued', sessionRef: { not: null } },
      select: { id: true, lastClaimedBy: true },
    });
    return rows.map((row) => ({ runId: row.id, startedBy: row.lastClaimedBy }));
  }

  async abandonResume(runId: string, failure: RunFailure, now: Date): Promise<boolean> {
    const { count } = await this.db.run.updateMany({
      where: { id: runId, state: 'queued', sessionRef: { not: null } },
      data: {
        state: 'failed',
        failureCode: failure.code,
        failureDetail: failure.detail,
        finishedAt: now,
        followUpQueued: false,
      },
    });
    return count === 1;
  }

  async findStates(ids: readonly string[]): Promise<RunStateView[]> {
    const rows = await this.db.run.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        projectId: true,
        provider: true,
        sessionRef: true,
        state: true,
        finishedAt: true,
        pullRequestNumber: true,
        prState: true,
        prEndedAt: true,
        lastActivityAt: true,
      },
    });
    return rows.map((row) => {
      if (!includes(RUN_STATES, row.state)) {
        throw new Error(`Unexpected run state in the database: ${row.state}`);
      }
      return {
        runId: row.id,
        projectId: row.projectId,
        provider: row.provider as Provider,
        sessionRef: row.sessionRef,
        state: row.state,
        finishedAt: row.finishedAt,
        hasPullRequest: row.pullRequestNumber !== null,
        // The CHECK constraint fixes the state's values.
        pullRequestState: row.prState as PullRequestState | null,
        pullRequestEndedAt: row.prEndedAt,
        lastActivityAt: row.lastActivityAt,
      };
    });
  }

  async findLimitedRuns(projectIds: readonly string[]): Promise<LimitedRunView[]> {
    if (projectIds.length === 0) return [];
    const rows = await this.db.run.findMany({
      where: {
        projectId: { in: [...projectIds] },
        state: { in: [...FINAL_RUN_STATES] },
        finishedAt: { not: null },
        pullRequestNumber: null,
        // Only Runs that have a Working copy (one the worker reported): a Run cancelled while
        // queued, or refused before its clone, holds no place in the limit.
        runBranch: { not: null },
        workingCopyRemovedAt: null,
      },
      select: { id: true, projectId: true, finishedAt: true },
    });
    return rows.flatMap((row) =>
      row.finishedAt === null
        ? []
        : [{ runId: row.id, projectId: row.projectId, finishedAt: row.finishedAt }],
    );
  }

  async listSteps(runId: string): Promise<(RunStepSnapshot & { reportedAt: Date })[]> {
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
    return inTransaction(this.db, async (tx) => {
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
      // A delivery retry whose worker was lost: still a failed delivery.
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

  async findEnvironmentFileSecret(runId: string): Promise<string | null> {
    const row = await this.db.run.findUnique({
      where: { id: runId },
      select: { environmentFileSecretId: true },
    });
    return row?.environmentFileSecretId ?? null;
  }

  async listReleasableEnvironmentFileSecrets(
    retryableFinishedBefore: Date,
  ): Promise<{ runId: string; secretRef: string }[]> {
    const rows = await this.db.run.findMany({
      where: {
        state: { in: [...FINAL_RUN_STATES] },
        environmentFileSecretId: { not: null },
        // A failed delivery that can still be retried keeps its snapshot, and so does a Run stopped
        // at the usage limit, which can be resumed.
        NOT: {
          state: 'failed',
          failureCode: { in: ['delivery_failed', 'usage_limit'] },
          OR: [{ deliveryRequested: true }, { finishedAt: { gte: retryableFinishedBefore } }],
        },
      },
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
