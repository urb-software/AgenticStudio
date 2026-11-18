export class InvalidEnvironmentFilePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEnvironmentFilePathError';
  }
}

/** The path is tracked in the repository: writing the file would overwrite a tracked file. */
export class EnvironmentFilePathTrackedError extends InvalidEnvironmentFilePathError {
  constructor() {
    super(
      'This path is tracked in the repository at the current commit of the integration branch. ' +
        'Choose a path Git does not track, so no tracked file is overwritten.',
    );
    this.name = 'EnvironmentFilePathTrackedError';
  }
}

/** The content is not acceptable; `message` says why and never quotes the content. */
export class InvalidEnvironmentFileContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEnvironmentFileContentError';
  }
}
