/** No Project has this id. */
export class ProjectNotFoundError extends Error {
  constructor() {
    super('No project has this id.');
    this.name = 'ProjectNotFoundError';
  }
}

/** The settings cannot be removed while the Project's Preview is running. */
export class PreviewRunningError extends Error {
  constructor() {
    super('The Preview is running. Stop it before you remove its settings.');
    this.name = 'PreviewRunningError';
  }
}

/** Why the settings were not accepted, as plain data: the code and the place in the request or the file. */
export interface PreviewRefusalData {
  readonly code: string;
  readonly place: string;
  readonly message: string;
}

/** The Compose file or the choice was refused; every reason found is in `refusals`. */
export class PreviewRefusedError extends Error {
  constructor(readonly refusals: readonly PreviewRefusalData[]) {
    super('The Preview settings were refused.');
    this.name = 'PreviewRefusedError';
  }
}

export type PreviewRepositoryReason =
  'no_repository' | 'repository_not_ready' | 'unsupported_platform';

/** The Repository cannot be read for a Preview: not connected, not ready, or not on a Linux host. */
export class PreviewRepositoryNotReadyError extends Error {
  constructor(readonly reason: PreviewRepositoryReason) {
    super('The Repository cannot be read for a Preview now.');
    this.name = 'PreviewRepositoryNotReadyError';
  }
}

/** Reading the Compose file from the Repository failed for a reason that is not the operator's. */
export class PreviewSourceUnavailableError extends Error {
  constructor() {
    super('The Compose file could not be read from the Repository.');
    this.name = 'PreviewSourceUnavailableError';
  }
}
