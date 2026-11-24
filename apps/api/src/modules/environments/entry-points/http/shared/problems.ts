import { CONTROLLER_PROBLEM_TYPES } from '@agentic-studio/contracts';
import { HttpStatus } from '@nestjs/common';
import type {
  PreviewLimitReachedError,
  PreviewRepositoryReason,
} from '../../../domain/errors/preview-settings-errors.js';
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
  /** 409: a build was asked for but the Project has no Preview settings. */
  previewNotConfigured: 'urn:agentic-studio:problem:preview-not-configured',
  /** 409: a build was asked for but no environment controller is connected. */
  controllerUnavailable: 'urn:agentic-studio:problem:preview-controller-unavailable',
  /** 409: a build of the Project is already requested or claimed. */
  buildRunning: 'urn:agentic-studio:problem:preview-build-running',
  /** 409: a stop or a data removal of the Project is already requested or claimed. */
  previewBusy: 'urn:agentic-studio:problem:preview-busy',
  /** 409: stop was asked but the Preview does not run. */
  previewNotRunning: 'urn:agentic-studio:problem:preview-not-running',
  /** 409: every place of the running limit is taken; `running` lists the Projects. */
  previewLimitReached: 'urn:agentic-studio:problem:preview-limit-reached',
  /** 404: no build of the Project has this id. */
  buildNotFound: 'urn:agentic-studio:problem:preview-build-not-found',
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

export function repositoryNotReady(reason: PreviewRepositoryReason): ProblemException {
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

export function previewNotConfigured(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: ENVIRONMENTS_PROBLEM_TYPES.previewNotConfigured,
    title: 'Preview not configured',
    detail: 'Set the Preview settings before you build.',
  });
}

export function controllerUnavailable(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: ENVIRONMENTS_PROBLEM_TYPES.controllerUnavailable,
    title: 'No environment controller connected',
    detail: 'No environment controller is connected. Builds start once it runs.',
  });
}

export function buildRunning(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: ENVIRONMENTS_PROBLEM_TYPES.buildRunning,
    title: 'Build running',
    detail: 'A build of this Preview is already running.',
  });
}

export function previewBusy(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: ENVIRONMENTS_PROBLEM_TYPES.previewBusy,
    title: 'Preview busy',
    detail: 'The Preview is being stopped or its data removed. Try again when it is done.',
  });
}

export function previewNotRunning(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: ENVIRONMENTS_PROBLEM_TYPES.previewNotRunning,
    title: 'Preview not running',
    detail: 'The Preview is not running, so there is nothing to stop.',
  });
}

export function previewLimitReached(error: PreviewLimitReachedError): ProblemException {
  const running = error.running.map(({ projectId, state }) => ({
    projectId,
    name: error.names.get(projectId) ?? projectId,
    state,
  }));
  return new ProblemException(HttpStatus.CONFLICT, {
    type: ENVIRONMENTS_PROBLEM_TYPES.previewLimitReached,
    title: 'Preview limit reached',
    detail:
      `At most ${error.limit} Previews run at the same time. ` +
      `Running now: ${running.map((preview) => preview.name).join(', ')}. Stop one first.`,
    extensions: { running },
  });
}

export function buildNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: ENVIRONMENTS_PROBLEM_TYPES.buildNotFound,
    title: 'Build not found',
    detail: 'No build of this Project has this id.',
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

export function operationNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: CONTROLLER_PROBLEM_TYPES.operationNotFound,
    title: 'Preview operation not found',
    detail: 'No Preview operation has this id.',
  });
}

/** 409: the controller must abandon the operation. */
export function operationNotHeld(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: CONTROLLER_PROBLEM_TYPES.operationNotHeld,
    title: 'Preview operation not held',
    detail: 'This controller does not hold the operation, or it is already final.',
  });
}

export function operationSourceUnavailable(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: CONTROLLER_PROBLEM_TYPES.sourceUnavailable,
    title: 'Source unavailable',
    detail: 'The source of this build cannot be read from the repository now.',
  });
}

export function operationSourceTooLarge(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: CONTROLLER_PROBLEM_TYPES.sourceTooLarge,
    title: 'Source too large',
    detail: 'The source archive of this build is over the size limit.',
  });
}

export function operationNotABuild(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: CONTROLLER_PROBLEM_TYPES.operationNotABuild,
    title: 'Not a build',
    detail: 'Only a build has a source.',
  });
}
