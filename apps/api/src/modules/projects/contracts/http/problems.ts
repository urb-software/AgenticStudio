import { HttpStatus } from '@nestjs/common';
import {
  HandledServerErrorException,
  ProblemException,
} from '../../../../platform/http/problem-details.js';

/**
 * Problem `type` URIs of the projects API (RFC 9457 §3.1.1), shared by several features of
 * this module. Each names one deliberate error; generic validation errors stay `about:blank`.
 */
export const PROJECTS_PROBLEM_TYPES = {
  /** 404: no project has this id. */
  projectNotFound: 'urn:agentic-studio:problem:project-not-found',
  /** 404: the project has no Repository. */
  noRepository: 'urn:agentic-studio:problem:no-repository',
  /** 409: the project already has a Repository that is connecting or connected. */
  repositoryAlreadyConnected: 'urn:agentic-studio:problem:repository-already-connected',
  /** 409: another project holds the same remote; a field error on `url` names it. */
  remoteAlreadyConnected: 'urn:agentic-studio:problem:remote-already-connected',
  /** 409: an earlier clone of the project is still waiting or running. */
  cloneAlreadyRunning: 'urn:agentic-studio:problem:clone-already-running',
  /** 409: a connect or fetch of the Repository is still running. */
  repositoryBusy: 'urn:agentic-studio:problem:repository-busy',
  /** 409: the Repository has no usable Clone to fetch into; Retry (connect) makes one. */
  noUsableClone: 'urn:agentic-studio:problem:no-usable-clone',
  /** 409: the Repository is not waiting for its Deploy key or host key to be verified. */
  repositoryNotVerifiable: 'urn:agentic-studio:problem:repository-not-verifiable',
  /** 501: repository features need a Linux API host. */
  unsupportedPlatform: 'urn:agentic-studio:problem:unsupported-platform',
} as const;

/** 404 for an unknown project id (also for an id that is not a UUID). */
export function projectNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: PROJECTS_PROBLEM_TYPES.projectNotFound,
    title: 'Project not found',
    detail: 'No project has this id.',
  });
}

/** 404 for a project without a Repository. */
export function noRepository(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: PROJECTS_PROBLEM_TYPES.noRepository,
    title: 'No repository',
    detail: 'The project has no repository.',
  });
}

/** 501 when the API host is not Linux; `action` names what the operator tried (connect, fetch). */
export function unsupportedPlatform(action: string): ProblemException {
  return new ProblemException(HttpStatus.NOT_IMPLEMENTED, {
    type: PROJECTS_PROBLEM_TYPES.unsupportedPlatform,
    title: 'Unsupported platform',
    detail:
      'Repository features run on Linux only, and this Studio API is not running on Linux. ' +
      `Run the API in a Linux container or on a Linux host to ${action} repositories.`,
  });
}

/** 503 when the job queue is down; the queue logs the outage itself (once). */
export function queueUnavailable(): HandledServerErrorException {
  return new HandledServerErrorException(HttpStatus.SERVICE_UNAVAILABLE);
}
