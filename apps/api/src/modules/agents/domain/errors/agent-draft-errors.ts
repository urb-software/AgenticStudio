/** The Draft would change more files than the limit. */
export class DraftTooManyFilesError extends Error {
  constructor(readonly limit: number) {
    super(`The Draft would change more than ${limit} files.`);
    this.name = 'DraftTooManyFilesError';
  }
}

/** The files of the Draft would together pass the total limit. */
export class DraftTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`The Draft would hold ${size} bytes, over the limit of ${limit} bytes.`);
    this.name = 'DraftTooLargeError';
  }
}

/** The path is a symbolic link or a submodule at the base commit: it can be neither written nor deleted. */
export class DraftPathNotWritableError extends Error {
  constructor(readonly path: string) {
    super('The path is a symbolic link or a submodule at the base commit.');
    this.name = 'DraftPathNotWritableError';
  }
}

/** A move to a path where a file already is (and the Draft does not delete it). */
export class DraftPathTakenError extends Error {
  constructor(readonly path: string) {
    super('A file already exists at the path.');
    this.name = 'DraftPathTakenError';
  }
}

/** The path would be a file where a folder is, or a folder where a file is. */
export class DraftPathConflictError extends Error {
  constructor(readonly path: string) {
    super('The path would be both a file and a folder.');
    this.name = 'DraftPathConflictError';
  }
}

/** No file is at the path, in the Draft or at the base commit. */
export class DraftFileNotFoundError extends Error {
  constructor(readonly path: string) {
    super('No file is at the path.');
    this.name = 'DraftFileNotFoundError';
  }
}

/** The Repository has no commit to start a Draft from. */
export class DraftNoBaseError extends Error {
  constructor() {
    super('The definitions Repository has no commit to base a Draft on.');
    this.name = 'DraftNoBaseError';
  }
}

/** The base commit's tree cannot be read now (not Linux, no Clone, the commit is gone, or the tree was cut). */
export class DraftBaseUnreadableError extends Error {
  constructor() {
    super('The definitions Repository cannot be read now.');
    this.name = 'DraftBaseUnreadableError';
  }
}

/** A base file cannot move because Studio cannot carry its bytes: it is binary or over the file limit. */
export class DraftMoveUnsupportedError extends Error {
  constructor(readonly reason: 'binary' | 'too_large') {
    super('The file cannot be moved: it is binary or over the file limit.');
    this.name = 'DraftMoveUnsupportedError';
  }
}
