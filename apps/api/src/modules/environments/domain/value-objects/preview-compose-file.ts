// eslint-disable-next-line no-control-regex -- control characters (NUL included) are refused
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export class InvalidPreviewComposeFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPreviewComposeFileError';
  }
}

/** Where a Preview's Compose file is in the Integration branch: a relative POSIX path. */
export class PreviewComposeFile {
  /** Longest path, in characters. */
  static readonly MAX_LENGTH = 255;

  private constructor(readonly value: string) {}

  /** Throws {@link InvalidPreviewComposeFileError}; whether the file exists needs the Repository. */
  static of(path: string): PreviewComposeFile {
    const problem = PreviewComposeFile.problemWith(path);
    if (problem !== null) throw new InvalidPreviewComposeFileError(problem);
    return new PreviewComposeFile(path);
  }

  private static problemWith(path: string): string | null {
    if (path.length === 0) return 'Enter the path of the Compose file.';
    if (path.length > PreviewComposeFile.MAX_LENGTH) {
      return `The path is longer than ${PreviewComposeFile.MAX_LENGTH} characters.`;
    }
    if (CONTROL_CHARACTER.test(path)) return 'The path contains a control character.';
    if (path.includes('\\')) return 'Use forward slashes (/) in the path, not backslashes.';
    if (path.startsWith('/')) {
      return 'The path must be relative to the repository root, without a leading /.';
    }
    if (path.startsWith('./')) return 'Write the path without a leading ./.';
    const segments = path.split('/');
    if (segments.includes('..')) return 'The path must stay inside the repository (no ..).';
    if (segments.includes('.')) return 'The path must not contain . segments.';
    if (segments.includes('')) {
      return 'The path must not contain empty segments (// or a trailing /).';
    }
    if (segments.some((segment) => segment.toLowerCase() === '.git')) {
      return 'The path must not be inside .git.';
    }
    return null;
  }
}
