import type { Run } from '../domain/entities/run.js';
import type { Provider } from '../domain/value-objects/provider.js';
import type { RunCancelledBy } from '../domain/value-objects/run-cancelled-by.js';
import type { RunDeliveryState } from '../domain/value-objects/run-delivery.js';
import type { RunFailureCode } from '../domain/value-objects/run-failure-code.js';
import type { RunLimits } from '../domain/value-objects/run-limits.js';
import type { RunMessage } from '../domain/value-objects/run-message.js';
import type { RunPullRequestChecks } from '../domain/value-objects/run-pull-request-checks.js';
import type { RunState } from '../domain/value-objects/run-state.js';
import type { PullRequestState } from '../domain/value-objects/pull-request-state.js';
import type { RunWorkingCopy } from '../domain/value-objects/run-working-copy.js';

/** A Run as the queries and commands that show it report it: what the operator may see of it. */
export interface RunView {
  id: string;
  projectId: string;
  provider: Provider;
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
  stepsBeforePart: number;
  followUpCount: number;
  pushedCommit: string | null;
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
    refreshRequestedAt: Date | null;
    checks: RunPullRequestChecks | null;
    prepareRequestedAt: Date | null;
    prepareError: string | null;
  };
  failingChecks: string[];
  /** Internal: the operator API shows only whether a Run can resume. */
  sessionRef: string | null;
  /** Empty in a list of Runs. */
  messages: RunMessage[];
}

export function runView(run: Run): RunView {
  const { lifecycle, delivery, progress, pullRequestStatus: status } = run;
  return {
    id: run.id,
    projectId: run.projectId,
    provider: run.provider,
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
    stepsBeforePart: progress.stepsBeforePart,
    followUpCount: progress.followUpCount,
    pushedCommit: delivery.pushedCommit,
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
      refreshRequestedAt: status.refreshRequestedAt,
      checks: status.checks,
      prepareRequestedAt: status.prepareRequestedAt,
      prepareError: status.prepareError,
    },
    failingChecks: [...run.failingChecks],
    sessionRef: run.claim.sessionRef,
    messages: [...run.conversation.messages],
  };
}
