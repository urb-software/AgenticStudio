import { HttpStatus } from '@nestjs/common';
import type { z } from 'zod';
import { ProblemException } from '../../../../../platform/http/problem-details.js';
import type { followUpRefusalSchema } from './run-response.js';

export const EXECUTIONS_PROBLEM_TYPES = {
  projectNotFound: 'urn:agentic-studio:problem:project-not-found',
  runNotFound: 'urn:agentic-studio:problem:run-not-found',
  repositoryNotReady: 'urn:agentic-studio:problem:repository-not-ready',
  providerUnavailable: 'urn:agentic-studio:problem:provider-unavailable',
  runNotHeld: 'urn:agentic-studio:problem:run-not-held',
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
} as const;

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

export function providerUnavailable(detail: string): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.providerUnavailable,
    title: 'Provider unavailable',
    detail,
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
