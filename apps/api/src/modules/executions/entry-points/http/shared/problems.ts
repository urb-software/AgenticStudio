import { HttpStatus } from '@nestjs/common';
import type { ClosePullRequestRefusal, MergeRefusal } from '@agentic-studio/contracts';
import type { z } from 'zod';
import { ProblemException } from '../../../../../platform/http/problem-details.js';
import type { MergeReviewRefusal } from '../../../domain/value-objects/merge-review-refusal.js';
import type { followUpRefusalSchema } from './run-response.js';

export const EXECUTIONS_PROBLEM_TYPES = {
  projectNotFound: 'urn:agentic-studio:problem:project-not-found',
  /** 409: the Project is the definitions Repository, which accepts no Run. */
  definitionsProject: 'urn:agentic-studio:problem:definitions-project',
  runNotFound: 'urn:agentic-studio:problem:run-not-found',
  repositoryNotReady: 'urn:agentic-studio:problem:repository-not-ready',
  providerUnavailable: 'urn:agentic-studio:problem:provider-unavailable',
  agentUnknown: 'urn:agentic-studio:problem:agent-unknown',
  agentNotUsable: 'urn:agentic-studio:problem:agent-not-usable',
  workflowUnknown: 'urn:agentic-studio:problem:workflow-unknown',
  workflowNotUsable: 'urn:agentic-studio:problem:workflow-not-usable',
  runNotHeld: 'urn:agentic-studio:problem:run-not-held',
  agentFolderUnavailable: 'urn:agentic-studio:problem:agent-folder-unavailable',
  agentFolderInvalid: 'urn:agentic-studio:problem:agent-folder-invalid',
  agentFolderCut: 'urn:agentic-studio:problem:agent-folder-cut',
  agentFolderReadFailed: 'urn:agentic-studio:problem:agent-folder-read-failed',
  skillsUnavailable: 'urn:agentic-studio:problem:skills-unavailable',
  skillsInvalid: 'urn:agentic-studio:problem:skills-invalid',
  skillsReadFailed: 'urn:agentic-studio:problem:skills-read-failed',
  tooManyLogStreams: 'urn:agentic-studio:problem:too-many-log-streams',
  illegalRunTransition: 'urn:agentic-studio:problem:illegal-run-transition',
  runAlreadyFinished: 'urn:agentic-studio:problem:run-already-finished',
  stepLimitReached: 'urn:agentic-studio:problem:step-limit-reached',
  stepOutOfOrder: 'urn:agentic-studio:problem:step-out-of-order',
  deliveryNotRetryable: 'urn:agentic-studio:problem:delivery-not-retryable',
  runNotWaiting: 'urn:agentic-studio:problem:run-not-waiting',
  runNotResumable: 'urn:agentic-studio:problem:run-not-resumable',
  resumeSlotTaken: 'urn:agentic-studio:problem:resume-slot-taken',
  followUpNotAllowed: 'urn:agentic-studio:problem:follow-up-not-allowed',
  runDiffNotFound: 'urn:agentic-studio:problem:run-diff-not-found',
  runDiffFileNotFound: 'urn:agentic-studio:problem:run-diff-file-not-found',
  pullRequestNotRefreshable: 'urn:agentic-studio:problem:pull-request-not-refreshable',
  noFailingChecks: 'urn:agentic-studio:problem:no-failing-checks',
  reviewCommentsLoadRunning: 'urn:agentic-studio:problem:review-comments-load-running',
  preparedFollowUpNotFound: 'urn:agentic-studio:problem:prepared-follow-up-not-found',
  lookupNotFound: 'urn:agentic-studio:problem:lookup-not-found',
  lookupNotHeld: 'urn:agentic-studio:problem:lookup-not-held',
  lookupKindMismatch: 'urn:agentic-studio:problem:lookup-kind-mismatch',
  noPullRequest: 'urn:agentic-studio:problem:no-pull-request',
  pullRequestNotOpen: 'urn:agentic-studio:problem:pull-request-not-open',
  reviewInProgress: 'urn:agentic-studio:problem:review-in-progress',
  unsupportedPlatform: 'urn:agentic-studio:problem:unsupported-platform',
  mergeReviewFileNotFound: 'urn:agentic-studio:problem:merge-review-file-not-found',
  closeRunActive: 'urn:agentic-studio:problem:close-run-active',
  closePullRequestNotOpen: 'urn:agentic-studio:problem:close-pull-request-not-open',
  closeMergeUnavailable: 'urn:agentic-studio:problem:close-merge-unavailable',
  closeHostRefused: 'urn:agentic-studio:problem:close-host-refused',
  closeInProgress: 'urn:agentic-studio:problem:close-in-progress',
  mergeChecksFailing: 'urn:agentic-studio:problem:merge-checks-failing',
  mergeChecksRunning: 'urn:agentic-studio:problem:merge-checks-running',
  mergeConflicting: 'urn:agentic-studio:problem:merge-conflicting',
  mergeRunActive: 'urn:agentic-studio:problem:merge-run-active',
  mergeCommitMoved: 'urn:agentic-studio:problem:merge-commit-moved',
  mergeReviewOutOfDate: 'urn:agentic-studio:problem:merge-review-out-of-date',
  mergePullRequestNotOpen: 'urn:agentic-studio:problem:merge-pull-request-not-open',
  mergeUnavailable: 'urn:agentic-studio:problem:merge-unavailable',
  mergeHostRefused: 'urn:agentic-studio:problem:merge-host-refused',
  mergeInProgress: 'urn:agentic-studio:problem:merge-in-progress',
} as const;

const MERGE_REVIEW_REFUSALS: Record<
  MergeReviewRefusal,
  { type: string; title: string; detail: string }
> = {
  no_pull_request: {
    type: EXECUTIONS_PROBLEM_TYPES.noPullRequest,
    title: 'No pull request',
    detail: 'The run has no pull request, or no known run branch, so there is nothing to review.',
  },
  pull_request_not_open: {
    type: EXECUTIONS_PROBLEM_TYPES.pullRequestNotOpen,
    title: 'Pull request not open',
    detail:
      "The run's pull request is merged, closed or gone, so there is nothing left to merge. Refresh its state or start a new run.",
  },
  repository_not_ready: {
    type: EXECUTIONS_PROBLEM_TYPES.repositoryNotReady,
    title: 'Repository not ready',
    detail: "The project's repository is not ready. Fetch it, then request the review again.",
  },
  review_in_progress: {
    type: EXECUTIONS_PROBLEM_TYPES.reviewInProgress,
    title: 'Review in progress',
    detail: 'A review of this run is already being prepared. Wait for it to finish.',
  },
  unsupported_platform: {
    type: EXECUTIONS_PROBLEM_TYPES.unsupportedPlatform,
    title: 'Reviews need Linux',
    detail: 'Studio computes the review with Git on Linux, and this API does not run on Linux.',
  },
};

export function mergeReviewRefused(reason: MergeReviewRefusal): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, MERGE_REVIEW_REFUSALS[reason]);
}

export function mergeReviewFileNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: EXECUTIONS_PROBLEM_TYPES.mergeReviewFileNotFound,
    title: 'File not in the review',
    detail: "The run's merge review lists no file at this path.",
  });
}

const FOLLOW_UP_REFUSAL_DETAILS: Record<z.infer<typeof followUpRefusalSchema>, string> = {
  pull_request_merged:
    "The run's pull request was merged on GitHub, so there is nothing left to update. Start a new run instead.",
  pull_request_closed:
    "The run's pull request was closed on GitHub. Reopen it there and refresh its state, or start a new run instead.",
  pull_request_missing:
    "The run's pull request or its run branch was not found on GitHub: it may be gone, or the Agent account cannot see it. Start a new run instead.",
  not_finished:
    'The run is still working or waiting for you. Send a Follow-up once it has finished.',
  follow_up_queued: 'A Follow-up is already queued for this run. Wait until it has finished.',
  working_copy_removed:
    "The run's working copy was removed on the agent worker. Start a new run instead.",
  no_session: 'The run has no agent session to continue. Start a new run instead.',
  step_total_reached:
    'The run has used all the run steps it may take in total. Start a new run instead.',
  provider_unavailable:
    "The run's provider is unavailable on the agent worker. Send the Follow-up once it is available.",
  worker_unavailable:
    "The agent worker that holds the run's working copy is not connected. Send the Follow-up once it is back.",
};

export function followUpNotAllowed(
  reason: z.infer<typeof followUpRefusalSchema>,
): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.followUpNotAllowed,
    title: 'Follow-up not possible',
    detail: FOLLOW_UP_REFUSAL_DETAILS[reason],
  });
}

export function pullRequestNotRefreshable(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.pullRequestNotRefreshable,
    title: 'No pull request to refresh',
    detail: 'The run has no pull request yet, so there is no state to refresh.',
  });
}

const CLOSE_REFUSALS: Record<
  Exclude<ClosePullRequestRefusal, 'host_refused'>,
  { type: string; title: string; detail: string }
> = {
  run_active: {
    type: EXECUTIONS_PROBLEM_TYPES.closeRunActive,
    title: 'The run is still active',
    detail: 'The run is still working or waiting. Close its pull request once it has ended.',
  },
  pull_request_not_open: {
    type: EXECUTIONS_PROBLEM_TYPES.closePullRequestNotOpen,
    title: 'The pull request is not open',
    detail:
      'The pull request is already merged, closed or gone, or the run has none. There is nothing to close.',
  },
  merge_unavailable: {
    type: EXECUTIONS_PROBLEM_TYPES.closeMergeUnavailable,
    title: 'Closing is switched off',
    detail:
      "Studio cannot close pull requests: the Merge credential is not set, or the run's Git host is not supported.",
  },
};

export function closePullRequestRefused(
  reason: ClosePullRequestRefusal,
  hostReason?: string,
): ProblemException {
  if (reason === 'host_refused') {
    return new ProblemException(HttpStatus.CONFLICT, {
      type: EXECUTIONS_PROBLEM_TYPES.closeHostRefused,
      title: 'The Git host refused',
      detail: hostReason ? `GitHub refused: ${hostReason}` : 'GitHub refused the request.',
    });
  }
  return new ProblemException(HttpStatus.CONFLICT, CLOSE_REFUSALS[reason]);
}

const MERGE_REFUSAL_PROBLEMS: Record<
  Exclude<MergeRefusal, 'host_refused'>,
  { type: string; title: string; detail: string }
> = {
  checks_failing: {
    type: EXECUTIONS_PROBLEM_TYPES.mergeChecksFailing,
    title: 'A check is failing',
    detail: 'A check of the pull request is failing. Fix it with a Follow-up, then review again.',
  },
  checks_running: {
    type: EXECUTIONS_PROBLEM_TYPES.mergeChecksRunning,
    title: 'Checks are still running',
    detail:
      'A check is still running, or GitHub has not yet worked out whether the pull request merges. Try again in a moment.',
  },
  conflicting: {
    type: EXECUTIONS_PROBLEM_TYPES.mergeConflicting,
    title: 'The pull request conflicts',
    detail:
      'The pull request conflicts with the Integration branch. Bring it up to date, then review again.',
  },
  run_active: {
    type: EXECUTIONS_PROBLEM_TYPES.mergeRunActive,
    title: 'The run is still active',
    detail: 'The run is still working or waiting. Merge its pull request once it has ended.',
  },
  commit_moved: {
    type: EXECUTIONS_PROBLEM_TYPES.mergeCommitMoved,
    title: 'The Run branch moved',
    detail:
      'The Run branch is not at the commit you reviewed. Review again to see what would be merged now.',
  },
  review_out_of_date: {
    type: EXECUTIONS_PROBLEM_TYPES.mergeReviewOutOfDate,
    title: 'No up-to-date merge review',
    detail: 'There is no ready merge review of the current commit. Request one, then try again.',
  },
  pull_request_not_open: {
    type: EXECUTIONS_PROBLEM_TYPES.mergePullRequestNotOpen,
    title: 'The pull request is not open',
    detail:
      'The pull request is already merged, closed or gone, or the run has none. There is nothing to merge.',
  },
  merge_unavailable: {
    type: EXECUTIONS_PROBLEM_TYPES.mergeUnavailable,
    title: 'Merging is switched off',
    detail:
      "Studio cannot merge pull requests: the Merge credential is not set, or the run's Git host is not supported.",
  },
  merge_in_progress: {
    type: EXECUTIONS_PROBLEM_TYPES.mergeInProgress,
    title: 'A merge is under way',
    detail: 'Another request is merging this pull request. Wait a moment and try again.',
  },
};

export function mergeRefused(reason: MergeRefusal, hostReason?: string): ProblemException {
  if (reason === 'host_refused') {
    return new ProblemException(HttpStatus.CONFLICT, {
      type: EXECUTIONS_PROBLEM_TYPES.mergeHostRefused,
      title: 'The Git host refused',
      detail: hostReason ? `GitHub refused: ${hostReason}` : 'GitHub refused the request.',
    });
  }
  return new ProblemException(HttpStatus.CONFLICT, MERGE_REFUSAL_PROBLEMS[reason]);
}

export function closeInProgress(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.closeInProgress,
    title: 'Closing is under way',
    detail: 'Another request is closing this pull request. Wait a moment and try again.',
  });
}

export function noFailingChecks(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.noFailingChecks,
    title: 'No failing checks',
    detail:
      'None of the pull request checks Studio knows of has failed. Refresh the pull request and try again.',
  });
}

export function reviewCommentsLoadRunning(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.reviewCommentsLoadRunning,
    title: 'Load already running',
    detail: 'A load of the review comments is already running. Wait for it to finish.',
  });
}

export function preparedFollowUpNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: EXECUTIONS_PROBLEM_TYPES.preparedFollowUpNotFound,
    title: 'No prepared Follow-up',
    detail: 'The run has no prepared Follow-up to review.',
  });
}

export function lookupNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: EXECUTIONS_PROBLEM_TYPES.lookupNotFound,
    title: 'Lookup not found',
    detail: 'No lookup has this id.',
  });
}

export function lookupNotHeld(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.lookupNotHeld,
    title: 'Lookup not held',
    detail: 'This agent worker does not hold the lookup. Drop it.',
  });
}

export function lookupKindMismatch(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.lookupKindMismatch,
    title: 'Lookup kind mismatch',
    detail: "The answer is not of the lookup's kind.",
  });
}

export function runDiffNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: EXECUTIONS_PROBLEM_TYPES.runDiffNotFound,
    title: 'No diff yet',
    detail: 'The run has not reported a result yet, so there is no diff.',
  });
}

export function runDiffFileNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: EXECUTIONS_PROBLEM_TYPES.runDiffFileNotFound,
    title: 'File not in the diff',
    detail: "The run's diff lists no file at this path.",
  });
}

export function projectNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: EXECUTIONS_PROBLEM_TYPES.projectNotFound,
    title: 'Project not found',
    detail: 'No project has this id.',
  });
}

export function definitionsProject(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.definitionsProject,
    title: 'Definitions Repository',
    detail: 'The definitions Repository accepts no Run.',
    extensions: { refused: 'run' },
  });
}

export function runNotResumable(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.runNotResumable,
    title: 'Run not resumable',
    detail: 'Only a run stopped at the usage limit, with an agent session, can be resumed.',
  });
}

export function resumeSlotTaken(detail: string): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.resumeSlotTaken,
    title: 'No free place to resume the run',
    detail,
  });
}

export function runNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: EXECUTIONS_PROBLEM_TYPES.runNotFound,
    title: 'Run not found',
    detail: 'No run has this id.',
  });
}

export function repositoryNotReady(detail: string): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.repositoryNotReady,
    title: 'Repository not ready',
    detail,
  });
}

export function providerUnavailable(
  detail: string,
  reason?: 'provider_disabled',
): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.providerUnavailable,
    title: 'Provider unavailable',
    detail,
    ...(reason === undefined ? {} : { extensions: { reason } }),
  });
}

/** 409 for a Run start naming an agent that no agent has. */
export function agentUnknown(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.agentUnknown,
    title: 'Agent unknown',
    detail: 'No agent has this name. Pick one of the agents offered for the project.',
    extensions: { reason: 'agent_unknown' },
  });
}

/** 409 for a Run start naming an agent whose definition has problems. */
export function agentNotUsable(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.agentNotUsable,
    title: 'Agent not usable',
    detail: 'The agent cannot be used: its definition has problems. See the Agents page.',
    extensions: { reason: 'agent_not_usable' },
  });
}

/** 409 for a Run start naming a Workflow that no folder has. */
export function workflowUnknown(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.workflowUnknown,
    title: 'Workflow unknown',
    detail: 'No Workflow has this name. Pick one of the Workflows offered for the project.',
    extensions: { reason: 'workflow_unknown' },
  });
}

/** 409 for a Run start naming a Workflow that cannot be used now; `reason` says why. */
export function workflowNotUsable(reason: string): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.workflowNotUsable,
    title: 'Workflow not usable',
    detail: `The Workflow cannot be used: ${reason}`,
    extensions: { reason: 'workflow_not_usable' },
  });
}

export function tooManyLogStreams(): ProblemException {
  return new ProblemException(HttpStatus.TOO_MANY_REQUESTS, {
    type: EXECUTIONS_PROBLEM_TYPES.tooManyLogStreams,
    title: 'Too many log streams',
    detail: 'Too many live logs are open. Close one and try again.',
  });
}

export function runNotHeld(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.runNotHeld,
    title: 'Run not held',
    detail: 'This agent worker does not hold the run. Stop working on it.',
  });
}

export function agentFolderUnavailable(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.agentFolderUnavailable,
    title: 'Agent files unavailable',
    detail: "The agent's files are no longer available in the definitions Repository.",
  });
}

export function agentFolderCut(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.agentFolderCut,
    title: 'Agent files cannot be read whole',
    detail: "The definitions Repository has too many files to read this agent's folder safely.",
  });
}

export function agentFolderReadFailed(): ProblemException {
  return new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, {
    type: EXECUTIONS_PROBLEM_TYPES.agentFolderReadFailed,
    title: 'Agent files not readable now',
    detail: "The agent's files could not be read right now. Try again.",
  });
}

export function agentFolderInvalid(detail: string): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.agentFolderInvalid,
    title: 'Agent files invalid',
    detail,
  });
}

export function skillsUnavailable(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.skillsUnavailable,
    title: 'Skills unavailable',
    detail: "The agent's skills are no longer available in the definitions Repository.",
  });
}

export function skillsInvalid(detail: string): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.skillsInvalid,
    title: 'Skills invalid',
    detail,
  });
}

export function skillsReadFailed(): ProblemException {
  return new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, {
    type: EXECUTIONS_PROBLEM_TYPES.skillsReadFailed,
    title: 'Skills not readable now',
    detail: "The agent's skills could not be read right now. Try again.",
  });
}

export function deliveryNotRetryable(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.deliveryNotRetryable,
    title: 'Delivery not retryable',
    detail: 'Only a run whose delivery failed can retry its delivery.',
  });
}

export function illegalRunTransition(detail: string): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.illegalRunTransition,
    title: 'Illegal run transition',
    detail,
  });
}

const FINAL_STATE_NAMES: Record<string, string> = {
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'was cancelled',
  timed_out: 'timed out',
};

export function runAlreadyFinished(state: string): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.runAlreadyFinished,
    title: 'Run already finished',
    detail: `The run has already finished: it ${FINAL_STATE_NAMES[state] ?? state}. There is nothing to cancel.`,
  });
}

export function stepLimitReached(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.stepLimitReached,
    title: 'Step limit reached',
    detail: 'The run reached its maximum number of run steps and has failed. Stop working on it.',
  });
}

export function stepOutOfOrder(expected: number): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.stepOutOfOrder,
    title: 'Step out of order',
    detail: `The next run step of this run is number ${expected}.`,
  });
}

const NOT_WAITING_DETAILS: Record<string, string> = {
  queued: 'The question was already answered; the run continues.',
  preparing: 'The question was already answered; the run continues.',
  running: 'The run is working; there is no question to answer.',
  succeeded: 'The run has already finished: it succeeded.',
  failed: 'The run has already finished: it failed.',
  cancelled: 'The run was cancelled; it takes no answer.',
  timed_out: 'The run has already finished: it timed out.',
};

export function runNotWaiting(state: string): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.runNotWaiting,
    title: 'Run not waiting for an answer',
    detail: NOT_WAITING_DETAILS[state] ?? 'The run is not waiting for an answer.',
  });
}
