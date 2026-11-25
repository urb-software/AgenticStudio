import { HttpStatus } from '@nestjs/common';
import {
  ProblemException,
  serviceUnavailable,
} from '../../../../../platform/http/problem-details.js';

/** Problem `type` URIs of the projects API (RFC 9457); generic validation errors stay `about:blank`. */
export const PROJECTS_PROBLEM_TYPES = {
  projectNotFound: 'urn:agentic-studio:problem:project-not-found',
  noRepository: 'urn:agentic-studio:problem:no-repository',
  repositoryAlreadyConnected: 'urn:agentic-studio:problem:repository-already-connected',
  /** 409: another project holds the same remote; a field error on `url` names it. */
  remoteAlreadyConnected: 'urn:agentic-studio:problem:remote-already-connected',
  repositoryBusy: 'urn:agentic-studio:problem:repository-busy',
  /** 409: the Repository has no usable Clone to fetch into; Retry (connect) makes one. */
  noUsableClone: 'urn:agentic-studio:problem:no-usable-clone',
  /** 409: the Repository is not waiting for its Deploy key or host key to be verified. */
  repositoryNotVerifiable: 'urn:agentic-studio:problem:repository-not-verifiable',
  unsupportedPlatform: 'urn:agentic-studio:problem:unsupported-platform',
  /** 409: the definitions Repository accepts no Run, no Preview and no Environment file. */
  definitionsProject: 'urn:agentic-studio:problem:definitions-project',
  /** 409: a definitions Project exists already; at most one does. */
  definitionsProjectExists: 'urn:agentic-studio:problem:definitions-project-exists',
} as const;

/** 404 for an unknown project id (also for an id that is not a UUID). */
export function projectNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: PROJECTS_PROBLEM_TYPES.projectNotFound,
    title: 'Project not found',
    detail: 'No project has this id.',
  });
}

export function noRepository(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: PROJECTS_PROBLEM_TYPES.noRepository,
    title: 'No repository',
    detail: 'The project has no repository.',
  });
}

export function repositoryBusy(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: PROJECTS_PROBLEM_TYPES.repositoryBusy,
    title: 'Repository busy',
    detail: 'A connect or fetch of this repository is still running. Try again when it ends.',
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

/** 503 (the generic body) when the job queue is down; the queue logs the outage itself (once). */
export function queueUnavailable(): ProblemException {
  return serviceUnavailable();
}

export function definitionsProjectExists(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: PROJECTS_PROBLEM_TYPES.definitionsProjectExists,
    title: 'Definitions Repository exists',
    detail: 'A definitions Repository is already connected. Disconnect it to connect another.',
  });
}

/** 409 for a definitions Project that is asked for an Environment file. */
export function definitionsProjectEnvironmentFile(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: PROJECTS_PROBLEM_TYPES.definitionsProject,
    title: 'Definitions Repository',
    detail: 'The definitions Repository accepts no Environment file.',
    extensions: { refused: 'environment_file' },
  });
}
