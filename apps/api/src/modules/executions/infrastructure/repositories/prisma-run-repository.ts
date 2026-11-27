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
import type { RunAgentSource } from '../../domain/value-objects/run-agent.js';
import type {
  RunPhaseData,
  RunPhaseKind,
  RunPhaseState,
} from '../../domain/value-objects/run-phase.js';
import type { RunWorkflowData, RunWorkflowItem } from '../../domain/value-objects/run-workflow.js';
import {
  RUN_CANCELLED_BY,
  type RunCancelledBy,
} from '../../domain/value-objects/run-cancelled-by.js';
import {
  RUN_FAILURE_CODES,
  type RunFailureCode,
} from '../../domain/value-objects/run-failure-code.js';
import { type RunFailure } from '../../domain/value-objects/run-failure.js';
import { isRunId } from '../../domain/value-objects/run-id.js';
import { type ResumeFacts } from '../../domain/entities/run-resume-facts.js';
import { type RunChanges } from '../../domain/entities/run-change-facts.js';
import { Run } from '../../domain/entities/run.js';
import { RunSlotTakenError } from '../../domain/errors/run-errors.js';
import { RUN_DELIVERIES, type RunDeliveryState } from '../../domain/value-objects/run-delivery.js';
import { type RunMessage } from '../../domain/value-objects/run-message.js';
import { type RunPartEnd } from '../../domain/value-objects/run-part-end.js';
import { type RunPullRequestChecks } from '../../domain/value-objects/run-pull-request-checks.js';
import { type PullRequestState } from '../../domain/value-objects/pull-request-state.js';
import { type RunWorkingCopy } from '../../domain/value-objects/run-working-copy.js';
import type { FollowUpSource } from '../../domain/value-objects/follow-up-source.js';
import { HandOutRule } from '../../domain/value-objects/hand-out-rule.js';
import type {
  LimitedRunView,
  RunRepository,
  RunStepView,
  RunsSummary,
  RunStateView,
} from '../../domain/repositories/run-repository.js';

/** A list of Runs never reads the agent's instructions. */
const PHASE_LIST_FIELDS = {
  position: true,
  itemId: true,
  kind: true,
  state: true,
  agentName: true,
  agentSource: true,
  agentCommit: true,
  agentProvider: true,
  agentModel: true,
  agentSkills: true,
  sessionRef: true,
  stepsBeforePart: true,
  _count: { select: { steps: true } },
} as const;

const LIST_FIELDS = {
  id: true,
  projectId: true,
  provider: true,
  currentPhase: true,
  workflowName: true,
  workflowCommit: true,
  // A list shows where a Run waits, which needs the recorded items.
  workflowItems: true,
  phasePending: true,
  checkpointItem: true,
  workflowEnded: true,
  phases: { select: PHASE_LIST_FIELDS, orderBy: { position: 'asc' } },
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
  lastClaimedBy: true,
  followUpCount: true,
  followUpQueued: true,
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
  closeClaimedAt: true,
  pullRequestClosedFromStudioAt: true,
  runBranchDeletedAt: true,
  runBranchDeletionFailure: true,
  lastActivityAt: true,
  _count: { select: { steps: true } },
} as const;

const RUN_FIELDS = {
  ...LIST_FIELDS,
  phases: {
    select: {
      ...PHASE_LIST_FIELDS,
      agentInstructions: true,
      summary: true,
      checkpointComment: true,
    },
    orderBy: { position: 'asc' },
  },
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

interface PhaseRow {
  position: number;
  itemId: string | null;
  kind: string;
  state: string;
  /** Left out of a list of Runs. */
  summary?: string | null;
  checkpointComment?: string | null;
  agentName: string;
  agentSource: string;
  agentCommit: string | null;
  agentProvider: string;
  agentModel: string;
  agentSkills: string[];
  /** Left out of a list of Runs. */
  agentInstructions?: string;
  sessionRef: string | null;
  stepsBeforePart: number;
  _count: { steps: number };
}

interface RunRow {
  id: string;
  projectId: string;
  provider: string;
  currentPhase: number;
  workflowName: string | null;
  workflowCommit: string | null;
  workflowItems: Prisma.JsonValue;
  phasePending: boolean;
  checkpointItem: number | null;
  workflowEnded: boolean;
  phases: PhaseRow[];
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
  lastClaimedBy: string | null;
  followUpCount: number;
  followUpQueued: boolean;
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
  closeClaimedAt: Date | null;
  pullRequestClosedFromStudioAt: Date | null;
  runBranchDeletedAt: Date | null;
  runBranchDeletionFailure: string | null;
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
  OR (a.state = 'queued' AND (a.has_session OR a.phase_pending) AND NOT a.follow_up_queued))`;

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

function toPhaseData(phase: PhaseRow): RunPhaseData {
  return {
    position: phase.position,
    itemId: phase.itemId,
    // The CHECK constraint keeps these lists.
    kind: phase.kind as RunPhaseKind,
    state: phase.state as RunPhaseState,
    sessionRef: phase.sessionRef,
    summary: phase.summary ?? null,
    checkpointComment: phase.checkpointComment ?? null,
    agent: {
      name: phase.agentName,
      // The CHECK constraint keeps the list; the Run's own check judges the rest.
      source: phase.agentSource as RunAgentSource,
      commit: phase.agentCommit,
      provider: phase.agentProvider as Provider,
      model: phase.agentModel,
      instructions: phase.agentInstructions ?? '',
      skills: phase.agentSkills,
    },
    stepsUsed: phase._count.steps,
  };
}

/** The recorded Workflow of a Run. */
function toWorkflow(row: RunRow): RunWorkflowData | null {
  if (row.workflowName === null || row.workflowCommit === null) return null;
  // Written by Studio from a validated plan.
  const items = row.workflowItems as unknown as RunWorkflowItem[];
  return { name: row.workflowName, commit: row.workflowCommit, items };
}

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
  const current = row.phases.find((phase) => phase.position === row.currentPhase);
  if (current === undefined) {
    throw new Error(`The run ${row.id} has no phase at its current position ${row.currentPhase}`);
  }
  return Run.restore({
    id: row.id,
    projectId: row.projectId,
    provider: row.provider as Provider,
    agent: toPhaseData(current).agent,
    phases: row.phases.map(toPhaseData),
    currentPhase: row.currentPhase,
    workflow: toWorkflow(row),
    phasePending: row.phasePending,
    checkpointItem: row.checkpointItem,
    workflowEnded: row.workflowEnded,
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
    sessionRef: current.sessionRef,
    messages: (row.messages ?? []).map(toMessage),
    lastClaimedBy: row.lastClaimedBy,
    stepCount: row._count.steps,
    followUpCount: row.followUpCount,
    followUpQueued: row.followUpQueued,
    stepsBeforePart: current.stepsBeforePart,
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
      closeClaimedAt: row.closeClaimedAt,
      closedFromStudioAt: row.pullRequestClosedFromStudioAt,
      runBranchDeletedAt: row.runBranchDeletedAt,
      runBranchDeletionFailure: row.runBranchDeletionFailure,
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
  startedAt: (startedAt) => ({ startedAt }),
  lastClaimedBy: (lastClaimedBy) => ({ lastClaimedBy }),
  followUpQueued: (followUpQueued) => ({ followUpQueued: followUpQueued! }),
  followUpCount: (followUpCount) => ({ followUpCount: followUpCount! }),
  // Held by the current Phase.
  stepsBeforePart: () => ({}),
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
  // Held by the current Phase; the Run keeps whether it is set.
  sessionRef: (sessionRef) => (sessionRef === undefined ? {} : { hasSession: sessionRef !== null }),
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
    closeClaimedAt: status!.closeClaimedAt,
    pullRequestClosedFromStudioAt: status!.closedFromStudioAt,
    runBranchDeletedAt: status!.runBranchDeletedAt,
    runBranchDeletionFailure: status!.runBranchDeletionFailure,
  }),
  // Counted from the stored Run steps, not a column.
  stepCount: () => ({}),
  currentPhase: (currentPhase) => ({ currentPhase: currentPhase! }),
  provider: (provider) => ({ provider: provider! }),
  phasePending: (phasePending) => ({ phasePending: phasePending! }),
  checkpointItem: (checkpointItem) => ({ checkpointItem: checkpointItem! }),
  workflowEnded: (workflowEnded) => ({ workflowEnded: workflowEnded! }),
  // Saved on the Phases.
  phaseUpdates: () => ({}),
};

function changedPhaseColumns(
  fields: RunChanges['fields'],
): Prisma.RunPhaseUncheckedUpdateInput | null {
  const data: Prisma.RunPhaseUncheckedUpdateInput = {};
  if (fields.sessionRef !== undefined) data.sessionRef = fields.sessionRef;
  if (fields.stepsBeforePart !== undefined) data.stepsBeforePart = fields.stepsBeforePart;
  return Object.keys(data).length > 0 ? data : null;
}

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

async function currentPhaseOf(
  tx: Prisma.TransactionClient,
  runId: string,
  moved?: number,
): Promise<string> {
  const currentPhase =
    moved ??
    (
      await tx.run.findUniqueOrThrow({
        where: { id: runId },
        select: { currentPhase: true },
      })
    ).currentPhase;
  const phase = await tx.runPhase.findUniqueOrThrow({
    where: { runId_position: { runId, position: currentPhase } },
    select: { id: true },
  });
  return phase.id;
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
        ...(run.workflow === null
          ? {}
          : {
              workflowName: run.workflow.name,
              workflowCommit: run.workflow.commit,
              workflowItems: run.workflow.items as unknown as Prisma.InputJsonValue,
            }),
        phases: {
          create: run.phases.map((phase) => ({
            position: phase.position,
            itemId: phase.itemId,
            kind: phase.kind,
            state: phase.state,
            agentName: phase.agent.name,
            agentSource: phase.agent.source,
            agentCommit: phase.agent.commit,
            agentProvider: phase.agent.provider,
            agentModel: phase.agent.model,
            agentInstructions: phase.agent.instructions,
            agentSkills: [...phase.agent.skills],
          })),
        },
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

  async listNewestFirst(): Promise<Run[]> {
    const rows = await this.db.run.findMany({ orderBy: [...NEWEST_FIRST], select: LIST_FIELDS });
    return rows.map((row) => toRun(row));
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

  async listByProjectNewestFirst(projectId: string): Promise<Run[]> {
    const rows = await this.db.run.findMany({
      where: { projectId },
      orderBy: [...NEWEST_FIRST],
      select: LIST_FIELDS,
    });
    return rows.map((row) => toRun(row));
  }

  async claimNext(
    workerId: string,
    now: Date,
    excludeProjectId: string | null = null,
  ): Promise<Run | null> {
    return inTransaction(
      this.db,
      async (tx) => {
        // Serializes claims (released at commit or rollback); other writers are not blocked.
        await tx.$queryRaw`
          SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('studio.executions.claim'))`;
        // FOR UPDATE waits for a held row lock and re-checks the row, so a concurrent cancel
        // cannot fail the claim and no Run is skipped for being briefly locked.
        const [selected] = await tx.$queryRaw<{ id: string }[]>`
          SELECT r.id FROM runs r
          WHERE (${excludeProjectId}::uuid IS NULL OR r.project_id <> ${excludeProjectId}::uuid)
            AND ((r.state = 'queued'
                  AND (NOT (r.has_session OR r.phase_pending)
                       OR r.last_claimed_by = ${workerId}::uuid))
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
          FOR UPDATE OF r`;
        if (!selected) return null;
        const read = () =>
          tx.run.findUniqueOrThrow({ where: { id: selected.id }, select: RUN_FIELDS });
        const run = toRun(await read());
        run.claimBy(workerId, now);
        await this.persist(tx, run);
        return toRun(await read());
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

  async listWaiting(): Promise<Run[]> {
    const rows = await this.db.run.findMany({
      where: { state: 'waiting_for_operator' },
      orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      select: LIST_FIELDS,
    });
    return rows.map((row) => toRun(row));
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
        const row = await tx.run.findUnique({
          where: { id: runId },
          select: { environmentFileSecretId: true },
        });
        mutate(run, {
          projectPlaceTaken: (places?.project ?? 0) > 0,
          serverPlacesTaken: places?.server ?? 0,
          environmentFileSnapshotKept: row?.environmentFileSecretId != null,
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
    // The Run's row still names the Phase the Run steps were taken in until it is updated below.
    let phaseId: Promise<string> | undefined;
    const phase = () => (phaseId ??= currentPhaseOf(tx, run.id));
    const phaseData = changedPhaseColumns(changes.fields);
    if (phaseData !== null) {
      // A Run that moved to another Phase carries that Phase's session and step count with it.
      const target = changes.fields.currentPhase;
      await tx.runPhase.update({
        where: {
          id: target === undefined ? await phase() : await currentPhaseOf(tx, run.id, target),
        },
        data: phaseData,
      });
    }
    for (const [position, update] of Object.entries(changes.fields.phaseUpdates ?? {})) {
      await tx.runPhase.update({
        where: { runId_position: { runId: run.id, position: Number(position) } },
        data: {
          ...(update.state === undefined ? {} : { state: update.state }),
          ...(update.summary === undefined ? {} : { summary: update.summary }),
          ...(update.sessionRef === undefined ? {} : { sessionRef: update.sessionRef }),
          ...(update.checkpointComment === undefined
            ? {}
            : { checkpointComment: update.checkpointComment }),
        },
      });
    }
    for (const step of changes.steps ?? []) {
      await tx.runStep.create({
        data: {
          runId: run.id,
          phaseId: await phase(),
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
      where: { state: 'queued', OR: [{ hasSession: true }, { phasePending: true }] },
      select: { id: true, lastClaimedBy: true },
    });
    return rows.map((row) => ({ runId: row.id, startedBy: row.lastClaimedBy }));
  }

  async findStates(ids: readonly string[]): Promise<RunStateView[]> {
    const rows = await this.db.run.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        projectId: true,
        provider: true,
        currentPhase: true,
        phases: { select: { position: true, sessionRef: true } },
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
        sessionRef:
          row.phases.find((phase) => phase.position === row.currentPhase)?.sessionRef ?? null,
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

  async listSteps(runId: string): Promise<RunStepView[]> {
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
