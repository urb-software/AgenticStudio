/** No Preview operation has this id. */
export class PreviewOperationNotFoundError extends Error {
  constructor() {
    super('No Preview operation has this id.');
    this.name = 'PreviewOperationNotFoundError';
  }
}

/** The controller does not hold the operation: it never did, lost it, or the operation is final. */
export class PreviewOperationNotHeldError extends Error {
  constructor() {
    super('The controller does not hold this Preview operation.');
    this.name = 'PreviewOperationNotHeldError';
  }
}

/** The operation is not in the state the change needs. */
export class IllegalPreviewOperationTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalPreviewOperationTransitionError';
  }
}

/** The Project has no Preview settings to build from. */
export class PreviewSettingsMissingError extends Error {
  constructor() {
    super('The Project has no Preview settings.');
    this.name = 'PreviewSettingsMissingError';
  }
}

/** The operation is not a build, so it has no source. */
export class PreviewOperationNotABuildError extends Error {
  constructor() {
    super('The Preview operation is not a build.');
    this.name = 'PreviewOperationNotABuildError';
  }
}
