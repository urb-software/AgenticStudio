import { HttpStatus } from '@nestjs/common';
import { ProblemException } from '../../../../platform/http/problem-details.js';

/**
 * Problem `type` URIs of the executions API (RFC 9457 §3.1.1), shared by several features of
 * this module. `project-not-found` is the same problem as in the projects API.
 */
export const EXECUTIONS_PROBLEM_TYPES = {
  /** 404: no project has this id. */
  projectNotFound: 'urn:agentic-studio:problem:project-not-found',
  /** 404: no Run has this id. */
  runNotFound: 'urn:agentic-studio:problem:run-not-found',
  /** 409: the project has no Repository, or it is not ready. */
  repositoryNotReady: 'urn:agentic-studio:problem:repository-not-ready',
  /** 409: the provider is switched off on the agent worker, or no agent worker is connected. */
  providerUnavailable: 'urn:agentic-studio:problem:provider-unavailable',
  /** 409 (worker routes): the reporting agent worker does not hold the Run. */
  runNotHeld: 'urn:agentic-studio:problem:run-not-held',
  /** 429: this session (or the server) has as many live log streams open as allowed. */
  tooManyLogStreams: 'urn:agentic-studio:problem:too-many-log-streams',
  /** 409 (worker routes): the reported state does not follow from the Run's state. */
  illegalRunTransition: 'urn:agentic-studio:problem:illegal-run-transition',
  /** 409: the Run has already reached a final state (Issue #100: cancel). */
  runAlreadyFinished: 'urn:agentic-studio:problem:run-already-finished',
  /** 409 (worker routes): a Run step beyond the Run's maximum; the Run is now failed (Issue #100). */
  stepLimitReached: 'urn:agentic-studio:problem:step-limit-reached',
  /** 409 (worker routes): a Run step's number is not the next one (review of #121). */
  stepOutOfOrder: 'urn:agentic-studio:problem:step-out-of-order',
  /** 409: the Run's delivery cannot be retried (it is not failed with delivery_failed). */
  deliveryNotRetryable: 'urn:agentic-studio:problem:delivery-not-retryable',
  /** 409: the Run is not waiting for the operator's answer (Issue #103). */
  runNotWaiting: 'urn:agentic-studio:problem:run-not-waiting',
  /** 409: the Run did not stop at the usage limit with a session to resume (Issue #105). */
  runNotResumable: 'urn:agentic-studio:problem:run-not-resumable',
  /** 409: the Run's project or the server has no free place to resume it in (Issue #105). */
  resumeSlotTaken: 'urn:agentic-studio:problem:resume-slot-taken',
  /** 404: the Run has no diff yet: no Run step reported a result (Issue #144). */
  runDiffNotFound: 'urn:agentic-studio:problem:run-diff-not-found',
  /** 404: the Run's diff lists no file at this path (Issue #144). */
  runDiffFileNotFound: 'urn:agentic-studio:problem:run-diff-file-not-found',
} as const;

/** 404: no Run step of the Run has reported a result, so it has no diff yet (Issue #144). */
export function runDiffNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: EXECUTIONS_PROBLEM_TYPES.runDiffNotFound,
    title: 'No diff yet',
    detail: 'The run has not reported a result yet, so there is no diff.',
  });
}

/** 404: the Run's diff of that scope lists no file at the path (Issue #144). */
export function runDiffFileNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: EXECUTIONS_PROBLEM_TYPES.runDiffFileNotFound,
    title: 'File not in the diff',
    detail: "The run's diff lists no file at this path.",
  });
}

/** 404 for an unknown project id (also for an id that is not a UUID). */
export function projectNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: EXECUTIONS_PROBLEM_TYPES.projectNotFound,
    title: 'Project not found',
    detail: 'No project has this id.',
  });
}

/** 409: only a Run stopped at the usage limit, with an agent session, can be resumed (#105). */
export function runNotResumable(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.runNotResumable,
    title: 'Run not resumable',
    detail: 'Only a run stopped at the usage limit, with an agent session, can be resumed.',
  });
}

/** 409: another Run holds the project's place, or the server's places are taken (#105). */
export function resumeSlotTaken(detail: string): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.resumeSlotTaken,
    title: 'No free place to resume the run',
    detail,
  });
}

/** 404 for an unknown Run id (also for an id that is not a UUID). */
export function runNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: EXECUTIONS_PROBLEM_TYPES.runNotFound,
    title: 'Run not found',
    detail: 'No run has this id.',
  });
}

/** 409 when a Run cannot start: `detail` says whether there is no Repository or it is not ready. */
export function repositoryNotReady(detail: string): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.repositoryNotReady,
    title: 'Repository not ready',
    detail,
  });
}

/** 409 when Studio knows the Run's provider is unavailable; `detail` says why. */
export function providerUnavailable(detail: string): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.providerUnavailable,
    title: 'Provider unavailable',
    detail,
  });
}

/** 429 when a live log stream would exceed the per-session or total limit. */
export function tooManyLogStreams(): ProblemException {
  return new ProblemException(HttpStatus.TOO_MANY_REQUESTS, {
    type: EXECUTIONS_PROBLEM_TYPES.tooManyLogStreams,
    title: 'Too many log streams',
    detail: 'Too many live logs are open. Close one and try again.',
  });
}

/** 409 on a worker route: this agent worker does not hold the Run (any more). */
export function runNotHeld(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.runNotHeld,
    title: 'Run not held',
    detail: 'This agent worker does not hold the run. Stop working on it.',
  });
}

/** 409 when a Run's delivery cannot be retried (Issue #102). */
export function deliveryNotRetryable(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.deliveryNotRetryable,
    title: 'Delivery not retryable',
    detail: 'Only a run whose delivery failed can retry its delivery.',
  });
}

/** 409 on a worker route: the reported state is not allowed from the Run's state. */
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

/** 409 when cancelling a Run that has already finished; `detail` says how it ended. */
export function runAlreadyFinished(state: string): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.runAlreadyFinished,
    title: 'Run already finished',
    detail: `The run has already finished: it ${FINAL_STATE_NAMES[state] ?? state}. There is nothing to cancel.`,
  });
}

/** 409 on a worker route: the reported Run step is beyond the Run's maximum; the Run failed. */
export function stepLimitReached(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.stepLimitReached,
    title: 'Step limit reached',
    detail: 'The run reached its maximum number of run steps and has failed. Stop working on it.',
  });
}

/** 409 on a worker route: the reported Run step is not the next one; nothing was stored. */
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

/** 409 when answering a Run that is not waiting for the operator (Issue #103); says why. */
export function runNotWaiting(state: string): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: EXECUTIONS_PROBLEM_TYPES.runNotWaiting,
    title: 'Run not waiting for an answer',
    detail: NOT_WAITING_DETAILS[state] ?? 'The run is not waiting for an answer.',
  });
}
