import { HttpStatus } from '@nestjs/common';
import { ProblemException } from '../../../../platform/http/problem-details.js';

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
