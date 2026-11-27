import type { Run } from '../domain/entities/run.js';
import type { Provider } from '../domain/value-objects/provider.js';
import type { RunAgentData } from '../domain/value-objects/run-agent.js';
import type { RunPhaseView } from '../domain/value-objects/run-phase-view.js';
import type { RunWorkflowData } from '../domain/value-objects/run-workflow.js';
import type { RunCancelledBy } from '../domain/value-objects/run-cancelled-by.js';
import type { RunDeliveryState } from '../domain/value-objects/run-delivery.js';
import type { RunFailureCode } from '../domain/value-objects/run-failure-code.js';
import type { RunLimits } from '../domain/value-objects/run-limits.js';
import type { RunMessage } from '../domain/value-objects/run-message.js';
import type { RunQuestion } from '../domain/value-objects/run-question.js';
import type { PullRequestRefreshOutcome } from '../domain/value-objects/pull-request-refresh-outcome.js';
import type { FailingChecksPreparationOutcome } from '../domain/value-objects/failing-checks-preparation-outcome.js';
import type { RunPullRequestChecks } from '../domain/value-objects/run-pull-request-checks.js';
import type { RunState } from '../domain/value-objects/run-state.js';
import type { PullRequestState } from '../domain/value-objects/pull-request-state.js';
import type { RunWorkingCopy } from '../domain/value-objects/run-working-copy.js';

/** A Run as the queries and commands that show it report it: what the operator may see of it. */
export interface RunView {
  id: string;
  projectId: string;
  provider: Provider;
  /** Without its instructions in a list of Runs. */
  agent: RunAgentData;
  /** In order; shown in a single-Run answer only. */
  phases: readonly RunPhaseView[];
  /** What the Run recorded of its Workflow; `null` for a Run started with an agent. */
  workflow: RunWorkflowData | null;
  /** A review Phase asked for changes: the Run delivered its pull request without an approval. */
  reviewNotPassed: boolean;
  task: string;
  state: RunState;
  startCommit: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  failure: { code: RunFailureCode; detail: string } | null;
  workingCopy: RunWorkingCopy | null;
  environmentFileSupplied: boolean;
  limits: RunLimits;
  stepCount: number;
  stepsInPart: number;
  followUpCount: number;
  /** Per commit of the Working copy; `null` when unknown. */
  commitsPushed: readonly boolean[] | null;
  cancelRequestedAt: Date | null;
  cancellation: { by: RunCancelledBy; reason: string } | null;
  delivery: RunDeliveryState | null;
  pullRequest: { url: string; number: number } | null;
  deliveryRequested: boolean;
  pullRequestStatus: {
    state: PullRequestState | null;
    behindBy: number | null;
    aheadBy: number | null;
    mergeable: boolean | null;
    refreshedAt: Date | null;
    refreshError: string | null;
    retryAt: Date | null;
    refresh: PullRequestRefreshOutcome;
    checks: RunPullRequestChecks | null;
    checksOnOtherCommit: boolean;
    preparation: FailingChecksPreparationOutcome;
    prepareError: string | null;
    closedFromStudioAt: Date | null;
    runBranchDeletedAt: Date | null;
    runBranchDeletionFailure: string | null;
  };
  failingChecks: readonly string[];
  resumable: boolean;
  question: RunQuestion | null;
  /** Empty in a list of Runs. */
  messages: RunMessage[];
}

export interface RunViewFacts {
  /** Unknown (`undefined`) in a list: the worker is then not treated as disconnected. */
  workerConnected?: boolean;
  preparedFollowUp: boolean;
}

export function runView(run: Run, facts: RunViewFacts): RunView {
  const { lifecycle, delivery, progress, pullRequestStatus: status } = run;
  return {
    id: run.id,
    projectId: run.projectId,
    provider: run.provider,
    agent: run.agent.toData(),
    phases: run.phases,
    workflow: run.workflow === null ? null : run.workflow.toData(),
    reviewNotPassed: run.reviewNotPassed,
    task: run.task,
    state: lifecycle.state,
    startCommit: run.startCommit,
    createdAt: run.createdAt,
    startedAt: lifecycle.startedAt,
    finishedAt: lifecycle.finishedAt,
    failure: lifecycle.failure
      ? { code: lifecycle.failure.code, detail: lifecycle.failure.detail }
      : null,
    workingCopy: run.workingCopy,
    environmentFileSupplied: run.claim.environmentFileSupplied,
    limits: progress.limits,
    stepCount: progress.stepCount,
    stepsInPart: progress.stepsInPart,
    followUpCount: progress.followUpCount,
    commitsPushed: run.commitsPushed(),
    cancelRequestedAt: lifecycle.cancelRequestedAt,
    cancellation: lifecycle.cancellation
      ? { by: lifecycle.cancellation.by, reason: lifecycle.cancellation.reason }
      : null,
    delivery: delivery.state,
    pullRequest: delivery.pullRequest,
    deliveryRequested: delivery.requested,
    pullRequestStatus: {
      state: status.state,
      behindBy: status.behindBy,
      aheadBy: status.aheadBy,
      mergeable: status.mergeable,
      refreshedAt: status.refreshedAt,
      refreshError: status.refreshError,
      retryAt: status.retryAt,
      refresh: status.refreshOutcome(facts.workerConnected),
      checks: status.checks,
      checksOnOtherCommit: status.checksOnOtherCommit(delivery.pushedCommit),
      preparation: status.preparationOutcome(facts.workerConnected, facts.preparedFollowUp),
      prepareError: status.prepareError,
      closedFromStudioAt: status.closedFromStudioAt,
      runBranchDeletedAt: status.runBranchDeletedAt,
      runBranchDeletionFailure: status.runBranchDeletionFailure,
    },
    failingChecks: [...run.failingChecks],
    resumable: run.resumable,
    question: run.openQuestion,
    messages: [...run.conversation.messages],
  };
}
