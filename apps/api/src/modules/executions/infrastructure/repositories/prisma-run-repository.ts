import { isUniqueConstraintViolation, Prisma } from '@agentic-studio/database';
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
  RUN_CANCELLED_BY,
  RUN_FAILURE_CODES,
  RUN_STATES,
  isRunId,
  type ResumeFacts,
  Run,
  RunSlotTakenError,
  type RunChanges,
  type RunCancellation,
  type RunCancelledBy,
  RUN_DELIVERIES,
  type RunDeliveryOutcome,
  type RunDeliveryState,
  type RunFailure,
  type RunFailureCode,
  type RunMessage,
  type FollowUpSource,
  restoreEarlierResult,
  type RunPullRequestChecks,
  type PullRequestState,
  type RunPartEnd,
  type RunState,
  type RunWorkingCopy,
  stepLimitFailure,
  UNDER_WAY_RUN_STATES,
} from '../../domain/entities/run.js';
import type { ReviewCommentSet } from '../../domain/value-objects/review-comments.js';
import { commentsSchema } from './review-comment-json.js';
import type {
  AppendStepOutcome,
  ClaimedRunChange,
  DeliveryRetryOutcome,
  LimitedRunView,
  NewRun,
  RunRepository,
  RunsSummary,
  RunStateView,
  RunStepRecord,
  StoredRunStep,
} from '../../domain/repositories/run-repository.js';

/** A Run's fields as lists read them: everything but its conversation (Issue #103). */
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
  // Issue #145: whether a prepared Follow-up waits for the operator.
  preparedFollowUp: { select: { runId: true } },
  prEndedAt: true,
  lastActivityAt: true,
  // Issue #141: the Run step total, counted with the Run.
  _count: { select: { steps: true } },
} as const;

/** A single Run's fields with its conversation (Issue #103); lists read {@link LIST_FIELDS}. */
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
  preparedFollowUp: { runId: string } | null;
  prEndedAt: Date | null;
  lastActivityAt: Date;
  _count: { steps: number };
  /** Absent when a list read the Run (Issue #103). */
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

const ACTIVE = Prisma.join([...ACTIVE_RUN_STATES]);

/** A message row as a Run's message (Issue #103); the CHECK constraint fixes the kinds. */
function toMessage(row: NonNullable<RunRow['messages']>[number]): RunMessage {
  if (row.kind === 'answer') return { kind: 'answer', text: row.text, at: row.at };
  if (row.kind === 'follow_up') {
    // The CHECK constraint fixes the source (Issues #145, #147).
    return {
      kind: 'follow_up',
      text: row.text,
      at: row.at,
      ...(row.source === null ? {} : { source: row.source as FollowUpSource }),
      ...(row.sourceCount === null
        ? {}
        : { sourceComments: { count: row.sourceCount, authors: row.sourceAuthors } }),
      // Issue #147: what a bring-up-to-date request records besides its note.
      ...(row.mergedCommit === null ? {} : { mergedCommit: row.mergedCommit }),
      ...(row.updateBase === null ? {} : { updateBase: row.updateBase }),
      ...(row.updateTip === null ? {} : { updateTip: row.updateTip }),
    };
  }
  if (row.kind === 'part_end') {
    // The CHECK constraints fix the state, the code and the delivery (review S1 of #150).
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

/**
 * The columns of a delivery outcome (Issue #102). Issue #141: a Run has at most one pull request,
 * so an outcome without one leaves a recorded pull request (from an earlier part of the Run) as
 * it is; the pushed commit is recorded whenever the worker reports one.
 */
function deliveryColumns(delivery: RunDeliveryOutcome) {
  return {
    delivery: delivery.outcome satisfies RunDeliveryState,
    ...(delivery.outcome === 'delivered'
      ? {
          pullRequestUrl: delivery.pullRequest.url,
          pullRequestNumber: delivery.pullRequest.number,
        }
      : {}),
    ...(delivery.pushedCommit === undefined ? {} : { pushedCommit: delivery.pushedCommit }),
  };
}

/**
 * Places held, as for a claim (SQL over `runs a`): an active state, a failed Run held for a
 * delivery retry (Issue #102), or an answered Run queued for its worker to resume (Issue #103).
 * A Run queued for a Follow-up holds none until it is claimed (Issue #141).
 */
const HOLDS_PLACE = Prisma.sql`(a.state IN (${ACTIVE})
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
      // Written by the lookups from a validated worker result (Issue #145).
      checks: row.prChecks as RunPullRequestChecks | null,
      prepareRequestedAt: row.prPrepareRequestedAt,
      prepareError: row.prPrepareError,
      preparedFollowUp: row.preparedFollowUp !== null,
      endedAt: row.prEndedAt,
    },
    lastActivityAt: row.lastActivityAt,
  });
}

/** A message as its row: the CHECK constraints fix the kinds (Issues #103, #141, #145, #146). */
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
      throw new Error('A question is added by the agent worker, not by an operator operation.');
  }
}

type ChangedField = keyof RunChanges['fields'];

/** The columns of the Run fields the operator's operations change; any other field is a bug. */
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
 * PostgreSQL adapter of {@link RunRepository} (Issue #96). Claims run in one transaction
 * under a transaction-scoped advisory lock, so concurrent claims are serialized and each sees
 * the others' committed result: together they cannot exceed one active Run per project or
 * `MAX_ACTIVE_RUNS` across the server; a `failed` Run a worker holds for a delivery retry
 * (Issue #102) and an answered Run queued for its worker to resume (Issue #103) count as active. The partial unique index on active Runs per project backs the
 * first limit in the schema itself.
 */
@Injectable()
export class PrismaRunRepository implements RunRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  async add(run: NewRun): Promise<Run> {
    const row = await this.db.run.create({
      data: {
        // The creation time is the database's (ordering by it must not depend on the API's clock).
        ...(run.id === undefined ? {} : { id: run.id }),
        projectId: run.projectId,
        provider: run.provider,
        task: run.task,
        startCommit: run.startCommit,
        remoteUrl: run.remoteUrl,
        integrationBranch: run.integrationBranch,
        state: 'queued',
        limitStepMinutes: run.limits.stepMinutes,
        limitMaxSteps: run.limits.maxSteps,
        limitWaitingDays: run.limits.waitingDays,
        limitMaxTotalSteps: run.limits.maxTotalSteps,
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
    const rows = await this.db.run.findMany({ orderBy: [...NEWEST_FIRST], select: LIST_FIELDS });
    return rows.map(toRun);
  }

  async summarize(): Promise<RunsSummary> {
    // One bounded aggregate over the non-final states: two counts, never the Runs.
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

  async listByProjectNewestFirst(projectId: string): Promise<Run[]> {
    const rows = await this.db.run.findMany({
      where: { projectId },
      orderBy: [...NEWEST_FIRST],
      select: LIST_FIELDS,
    });
    return rows.map(toRun);
  }

  async claimNext(workerId: string, now: Date): Promise<Run | null> {
    return this.db.$transaction(
      async (tx) => {
        // Serializes claims (released at commit or rollback); other writers are not blocked.
        await tx.$queryRaw`
          SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('studio.executions.claim'))`;
        // Active (holds a place): an active state, a failed Run held for a delivery retry
        // (Issue #102), or an answered Run queued for its worker to resume (Issue #103). A
        // candidate's own place does not count against it. A resumable Run goes only to the
        // worker that started it, like a delivery retry.
        const [next] = await tx.$queryRaw<{ id: string; state: string; started_at: Date | null }[]>`
          SELECT r.id, r.state, r.started_at FROM runs r
          WHERE ((r.state = 'queued'
                  AND (r.session_ref IS NULL OR r.last_claimed_by = ${workerId}::uuid))
                 OR (r.state = 'failed' AND r.delivery_requested AND r.claimed_by IS NULL
                     AND r.last_claimed_by = ${workerId}::uuid))
            AND (SELECT count(*) FROM runs a
                 WHERE a.id <> r.id AND ${HOLDS_PLACE}) < ${MAX_ACTIVE_RUNS}::int
            AND NOT EXISTS (SELECT 1 FROM runs a
                            WHERE a.id <> r.id
                              AND a.project_id = r.project_id
                              AND ${HOLDS_PLACE})
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
                  // A resumed Run keeps its first start (Issue #103).
                  startedAt: next.started_at ?? now,
                  heartbeatAt: now,
                  // A claimed Follow-up holds its places like any held Run (Issue #141).
                  followUpQueued: false,
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
        releasedBy: held ? null : change.workerId,
        ...(change.to === 'running' ? { stepStartedAt: change.now } : {}),
        ...(isFinal(change.to) ? { finishedAt: change.now } : {}),
        ...workingCopyColumns(change.workingCopy),
        ...((change.to === 'succeeded' || change.to === 'cancelled') && change.delivery
          ? deliveryColumns(change.delivery)
          : {}),
        ...(change.failure?.code === 'delivery_failed' ? { delivery: 'failed' } : {}),
        // Review S2 of #150: a delivery that pushed before it failed still records the push.
        ...(change.pushedCommit ? { pushedCommit: change.pushedCommit } : {}),
        // Issue #105: the session a Run stopped at the usage limit resumes later.
        ...(change.to === 'failed' && change.failure?.code === 'usage_limit' && change.sessionRef
          ? { sessionRef: change.sessionRef }
          : {}),
      },
    });
    return count === 1 ? this.findById(change.runId) : null;
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
        // A retried report of this outcome is then recognised (review of #121).
        releasedBy: outcome.workerId,
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
              ...(outcome.pushedCommit ? { pushedCommit: outcome.pushedCommit } : {}),
            }),
      },
    });
    return count === 1 ? this.findById(outcome.runId) : null;
  }

  async heartbeat(
    runId: string,
    workerId: string,
    now: Date,
  ): Promise<{ cancelRequested: boolean } | null> {
    // One statement: the renewal and the cancel request it answers with are read together.
    // Held: preparing or running, or failed during a delivery retry (Issue #102; the CHECK
    // constraint allows a holder in no other state).
    const [row] = await this.db.$queryRaw<{ cancel_requested: boolean }[]>`
      UPDATE runs SET heartbeat_at = ${now}
      WHERE id = ${runId}::uuid AND claimed_by = ${workerId}::uuid
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
        followUpQueued: false,
      },
    });
    return count === 1 ? this.findById(runId) : null;
  }

  async listWaiting(): Promise<Run[]> {
    const rows = await this.db.run.findMany({
      where: { state: 'waiting_for_operator' },
      orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      select: LIST_FIELDS,
    });
    return rows.map(toRun);
  }

  async renewClaimsOncePerLease(now: Date, leaseSeconds: number): Promise<number | null> {
    return this.db.$transaction(async (tx) => {
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

  async changeWithReviewComments(
    runId: string,
    mutate: (run: Run, loaded: ReviewCommentSet | null) => void,
  ): Promise<Run | null> {
    return this.changeLocked(runId, {}, async (run, tx) => {
      const stored = await tx.runReviewCommentSet.findUnique({ where: { runId } });
      const parsed = stored ? commentsSchema.safeParse(stored.comments) : undefined;
      // A stored set that does not validate is no loaded set.
      mutate(
        run,
        stored && parsed?.success
          ? {
              scope: stored.scope as ReviewCommentSet['scope'],
              comments: parsed.data,
              truncated: stored.truncated,
              loadedAt: stored.loadedAt,
            }
          : null,
      );
    });
  }

  async changeSerializedWithClaims(
    runId: string,
    mutate: (run: Run, facts: ResumeFacts) => void,
  ): Promise<Run | null> {
    try {
      return await this.changeLocked(runId, { serializedWithClaims: true }, async (run, tx) => {
        // Places held as for a claim: an active state, a failed Run held for a delivery retry, or
        // a Run queued to resume.
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
      // Backstop: the partial unique index on a project's active Run (Issue #103).
      if (isUniqueConstraintViolation(error)) throw new RunSlotTakenError('project');
      throw error;
    }
  }

  /**
   * Loads the Run FOR UPDATE, lets `work` change it, and saves its pending changes, all in one
   * transaction. `serializedWithClaims`: takes the claim lock first, as a claim does (the lock
   * order is the same everywhere, so claims and this change cannot deadlock).
   */
  private async changeLocked(
    runId: string,
    options: { serializedWithClaims?: boolean },
    work: (run: Run, tx: Prisma.TransactionClient) => void | Promise<void>,
  ): Promise<Run | null> {
    if (!isRunId(runId)) return null;
    return this.db.$transaction(async (tx) => {
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
      await this.save(tx, run);
      return toRun(await read());
    }, CLAIM_TRANSACTION);
  }

  /** Saves what an operator operation changed on the Run: its columns, messages and discards. */
  private async save(tx: Prisma.TransactionClient, run: Run): Promise<void> {
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
    if (changes.discardReviewComments) {
      await tx.runReviewCommentSet.deleteMany({ where: { runId: run.id } });
    }
    if (changes.discardPreparedFollowUp !== undefined) {
      await tx.runPreparedFollowUp.deleteMany({
        where: { runId: run.id, source: changes.discardPreparedFollowUp },
      });
    }
    if (Object.keys(data).length > 0) await tx.run.update({ where: { id: run.id }, data });
  }

  async recordUpdateStart(
    runId: string,
    workerId: string,
    start: { baseCommit: string; integrationCommit: string },
  ): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const held = await tx.run.count({ where: { id: runId, claimedBy: workerId } });
      if (held === 0) return false;
      const entry = await tx.runMessage.findFirst({
        where: { runId, kind: 'follow_up' },
        orderBy: { seq: 'desc' },
        select: { seq: true, source: true, updateTip: true },
      });
      if (!entry || entry.source !== 'bring_up_to_date' || entry.updateTip !== null) {
        return false;
      }
      await tx.runMessage.update({
        where: { runId_seq: { runId, seq: entry.seq } },
        data: { updateBase: start.baseCommit, updateTip: start.integrationCommit },
      });
      return true;
    });
  }

  async recordMergedCommit(runId: string): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const entry = await tx.runMessage.findFirst({
        where: { runId, kind: 'follow_up' },
        orderBy: { seq: 'desc' },
        select: { seq: true, source: true, updateTip: true, mergedCommit: true },
      });
      if (
        !entry ||
        entry.source !== 'bring_up_to_date' ||
        entry.updateTip === null ||
        entry.mergedCommit !== null
      ) {
        return false;
      }
      await tx.runMessage.update({
        where: { runId_seq: { runId, seq: entry.seq } },
        data: { mergedCommit: entry.updateTip },
      });
      return true;
    });
  }

  async finishBringUpToDate(
    runId: string,
    workerId: string,
    detail: string,
    now: Date,
  ): Promise<Run | null> {
    return this.db.$transaction(async (tx) => {
      // Locks the Run row: the condition and the return to the earlier result hold together.
      const [held] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM runs
        WHERE id = ${runId}::uuid AND claimed_by = ${workerId}
          AND state IN ('preparing', 'running')
        FOR UPDATE`;
      if (!held) return null;
      const entry = await tx.runMessage.findFirst({
        where: { runId, kind: 'follow_up' },
        orderBy: { seq: 'desc' },
        select: { seq: true, source: true },
      });
      if (!entry || entry.source !== 'bring_up_to_date') return null;
      const before = await tx.runMessage.findUnique({
        where: { runId_seq: { runId, seq: entry.seq - 1 } },
      });
      if (before?.kind !== 'part_end' || before.endState === null) return null;
      const ended = before.endState as RunPartEnd['state'];
      const last = await tx.runMessage.findFirst({
        where: { runId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      // Nothing was changed: the Run is as it was, and its conversation says so.
      await tx.runMessage.create({
        data: {
          runId,
          seq: (last?.seq ?? 0) + 1,
          kind: 'part_end',
          text: detail,
          endState: before.endState,
          endFailureCode: before.endFailureCode,
          endDelivery: before.endDelivery,
          at: now,
        },
      });
      const earlier = restoreEarlierResult({
        state: ended,
        failureCode: before.endFailureCode as RunFailureCode | null,
        delivery: before.endDelivery as RunDeliveryState | null,
        detail: before.text,
      });
      const row = await tx.run.update({
        where: { id: runId },
        data: {
          state: earlier.state,
          failureCode: earlier.failure?.code ?? null,
          failureDetail: earlier.failure?.detail ?? null,
          cancelledBy: earlier.cancellation?.by ?? null,
          cancelReason: earlier.cancellation?.reason ?? null,
          delivery: earlier.delivery,
          claimedBy: null,
          heartbeatAt: null,
          releasedBy: workerId,
          finishedAt: now,
          stepStartedAt: null,
        },
        select: RUN_FIELDS,
      });
      return toRun(row);
    });
  }

  async markWorkingCopiesRemoved(
    workerId: string,
    runIds: readonly string[],
    now: Date,
  ): Promise<number> {
    if (runIds.length === 0) return 0;
    // Only the worker that holds a Run's Working copy can report it gone, and only for a Run it
    // does not carry. Never dropped (review S9 of #150): a Follow-up queued meanwhile then fails
    // at its claim, and the Run says its Working copy was removed.
    const { count } = await this.db.run.updateMany({
      where: {
        id: { in: [...runIds] },
        lastClaimedBy: workerId,
        claimedBy: null,
        workingCopyRemovedAt: null,
      },
      data: { workingCopyRemovedAt: now },
    });
    return count;
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

  async appendStep(
    runId: string,
    workerId: string,
    step: RunStepRecord,
    workingCopy: RunWorkingCopy,
    failingChecks: readonly string[],
    now: Date,
  ): Promise<AppendStepOutcome> {
    return this.db.$transaction(async (tx): Promise<AppendStepOutcome> => {
      // Locks the Run row: the check and the numbering hold until the step is stored.
      const [run] = await tx.$queryRaw<
        {
          id: string;
          limit_max_steps: number;
          steps_before_part: number;
          follow_up_count: number;
        }[]
      >`
        SELECT id, limit_max_steps, steps_before_part, follow_up_count FROM runs
        WHERE id = ${runId}::uuid AND state = 'running' AND claimed_by = ${workerId}::uuid
        FOR UPDATE`;
      if (!run) return { status: 'not_held' };
      const last =
        (await tx.runStep.aggregate({ where: { runId }, _max: { index: true } }))._max.index ?? 0;
      const index = step.index ?? last + 1;
      // A retried report of a step already stored (review of #121): acknowledged, not stored.
      if (index <= last) return { status: 'stored', index, duplicate: true };
      if (index !== last + 1) return { status: 'out_of_order', expected: last + 1 };
      // Issue #141: each part (the first, or a Follow-up) gets its own allowance.
      if (index > run.steps_before_part + run.limit_max_steps) {
        // Issue #100: the step is not stored, and the Run fails under the same row lock.
        const failure = stepLimitFailure(run.limit_max_steps, run.follow_up_count > 0);
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
      // A question becomes the Run's next message (Issue #103), under the same row lock.
      if (step.question) {
        const lastMessage =
          (await tx.runMessage.aggregate({ where: { runId }, _max: { seq: true } }))._max.seq ?? 0;
        await tx.runMessage.create({
          data: {
            runId,
            seq: lastMessage + 1,
            kind: 'question',
            text: step.question.text,
            ...(step.question.options ? { options: [...step.question.options] } : {}),
            ...(step.question.recommendation === undefined
              ? {}
              : { recommendation: step.question.recommendation }),
            at: now,
          },
        });
      }
      // The latest Working copy state (Issue #98), failing checks (Issue #102) and session
      // reference (Issue #103), under the same row lock as the step.
      await tx.run.update({
        where: { id: runId },
        data: {
          ...workingCopyColumns(workingCopy),
          failingChecks: [...failingChecks],
          // The step is over: Studio's time-limit backstop no longer runs for it (review of
          // #121), so a slow delivery after it is never timed out.
          stepStartedAt: null,
          lastActivityAt: now,
          ...(step.sessionRef === undefined ? {} : { sessionRef: step.sessionRef }),
        },
      });
      return { status: 'stored', index };
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

  async replaceEnvironmentFile(
    runId: string,
    workerId: string,
    file: { path: string; secretRef: string } | null,
  ): Promise<boolean> {
    const { count } = await this.db.run.updateMany({
      where: { id: runId, state: 'preparing', claimedBy: workerId },
      data: {
        environmentFileSupplied: file !== null,
        environmentFilePath: file?.path ?? null,
        environmentFileSecretId: file?.secretRef ?? null,
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

  async listReleasableEnvironmentFileSecrets(
    retryableFinishedBefore: Date,
  ): Promise<{ runId: string; secretRef: string }[]> {
    const rows = await this.db.run.findMany({
      where: {
        state: { in: [...FINAL_RUN_STATES] },
        environmentFileSecretId: { not: null },
        // A failed delivery that can still be retried keeps its snapshot (Issue #104), and so
        // does a Run stopped at the usage limit, which can be resumed (Issue #105).
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
