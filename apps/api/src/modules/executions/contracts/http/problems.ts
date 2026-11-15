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
} as const;

/** 404 for an unknown project id (also for an id that is not a UUID). */
export function projectNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: EXECUTIONS_PROBLEM_TYPES.projectNotFound,
    title: 'Project not found',
    detail: 'No project has this id.',
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
