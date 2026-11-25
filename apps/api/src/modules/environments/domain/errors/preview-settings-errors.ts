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

/** A build of the Project is requested or claimed: no other change can start. */
export class PreviewBuildRunningError extends Error {
  constructor() {
    super('A build of this Preview is already running.');
    this.name = 'PreviewBuildRunningError';
  }
}

/** A stop or a data removal of the Project is requested or claimed: no other change can start. */
export class PreviewBusyError extends Error {
  constructor() {
    super('A stop or a data removal of this Preview is already running.');
    this.name = 'PreviewBusyError';
  }
}

/** Stop was asked for a Preview that does not run. */
export class PreviewNotRunningError extends Error {
  constructor() {
    super('The Preview is not running.');
    this.name = 'PreviewNotRunningError';
  }
}

/** Every place of the running limit is taken; `running` holds the Projects that take them. */
export class PreviewLimitReachedError extends Error {
  constructor(
    readonly limit: number,
    readonly running: readonly { projectId: string; state: string }[],
    /** Project names by id, filled in by the caller that can read them. */
    readonly names: ReadonlyMap<string, string> = new Map(),
  ) {
    super('The running Previews limit is reached.');
    this.name = 'PreviewLimitReachedError';
  }

  withNames(names: ReadonlyMap<string, string>): PreviewLimitReachedError {
    return new PreviewLimitReachedError(this.limit, this.running, names);
  }
}

/** No environment controller is connected to take a build. */
export class PreviewControllerUnavailableError extends Error {
  constructor() {
    super('No environment controller is connected.');
    this.name = 'PreviewControllerUnavailableError';
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

/** The Project is the definitions Repository, which accepts no Preview. */
export class DefinitionsProjectError extends Error {
  constructor() {
    super('The definitions Repository accepts no Preview.');
    this.name = 'DefinitionsProjectError';
  }
}
