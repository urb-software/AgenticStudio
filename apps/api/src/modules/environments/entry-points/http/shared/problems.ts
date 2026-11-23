import { HttpStatus } from '@nestjs/common';
import { ProblemException } from '../../../../../platform/http/problem-details.js';

/** Problem `type` URIs of the environments API (RFC 9457); generic validation errors stay `about:blank`. */
export const ENVIRONMENTS_PROBLEM_TYPES = {
  projectNotFound: 'urn:agentic-studio:problem:project-not-found',
  /** 409: the Repository cannot be read for a Preview now. */
  repositoryNotReady: 'urn:agentic-studio:problem:preview-repository-not-ready',
  /** 409: the API does not run on Linux, so no Repository can be read. */
  unsupportedPlatform: 'urn:agentic-studio:problem:preview-unsupported-platform',
  /** 409: the settings cannot be removed while the Preview runs. */
  previewRunning: 'urn:agentic-studio:problem:preview-running',
  /** 422: the Compose file or the choice was refused; `refusals` lists every reason. */
  previewRefused: 'urn:agentic-studio:problem:preview-refused',
  /** 502: the Compose file could not be read from the Repository. */
  sourceUnavailable: 'urn:agentic-studio:problem:preview-source-unavailable',
} as const;

/** 404 for an unknown project id (also for an id that is not a UUID). */
export function projectNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: ENVIRONMENTS_PROBLEM_TYPES.projectNotFound,
    title: 'Project not found',
    detail: 'No project has this id.',
  });
}

export function repositoryNotReady(
  reason: 'no_repository' | 'repository_not_ready' | 'unsupported_platform',
): ProblemException {
  if (reason === 'unsupported_platform') {
    return new ProblemException(HttpStatus.CONFLICT, {
      type: ENVIRONMENTS_PROBLEM_TYPES.unsupportedPlatform,
      title: 'Unsupported platform',
      detail:
        'Repository features run on Linux only, and this Studio API is not running on Linux. ' +
        'Run the API in a Linux container or on a Linux host to set up a Preview.',
    });
  }
  return new ProblemException(HttpStatus.CONFLICT, {
    type: ENVIRONMENTS_PROBLEM_TYPES.repositoryNotReady,
    title: 'Repository not ready',
    detail:
      reason === 'no_repository'
        ? 'The project has no repository. Connect one before you set up a Preview.'
        : 'The repository is not ready. Set up the Preview when it has finished connecting or fetching.',
  });
}

export function previewRunning(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: ENVIRONMENTS_PROBLEM_TYPES.previewRunning,
    title: 'Preview running',
    detail: 'The Preview is running. Stop it before you remove its settings.',
  });
}

export function previewRefused(
  refusals: readonly { code: string; place: string; message: string }[],
): ProblemException {
  return new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
    type: ENVIRONMENTS_PROBLEM_TYPES.previewRefused,
    title: 'Preview settings refused',
    detail: 'The Compose file or the choice was refused. The refusals say where and why.',
    extensions: { refusals },
  });
}

export function sourceUnavailable(): ProblemException {
  return new ProblemException(HttpStatus.BAD_GATEWAY, {
    type: ENVIRONMENTS_PROBLEM_TYPES.sourceUnavailable,
    title: 'Compose file unavailable',
    detail: 'The Compose file could not be read from the repository. Try again.',
  });
}
