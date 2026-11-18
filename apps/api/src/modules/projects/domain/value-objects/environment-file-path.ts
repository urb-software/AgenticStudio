import { InvalidEnvironmentFilePathError } from '../errors/environment-file-errors.js';

const MAX_LENGTH = 255;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** Where an Environment file is written: relative, inside the repository, never inside `.git`. */
export class EnvironmentFilePath {
  /** Longest path, in characters; the worker protocol's limit is pinned to it by a test. */
  static readonly MAX_LENGTH = MAX_LENGTH;

  private constructor(readonly value: string) {}

  /** Throws {@link InvalidEnvironmentFilePathError}; whether the path is tracked needs the Clone. */
  static of(path: string): EnvironmentFilePath {
    const problem = EnvironmentFilePath.problemWith(path);
    if (problem !== null) throw new InvalidEnvironmentFilePathError(problem);
    return new EnvironmentFilePath(path);
  }

  private static problemWith(path: string): string | null {
    if (path.length === 0) return 'Enter a path.';
    if (path.length > MAX_LENGTH) return `The path is longer than ${MAX_LENGTH} characters.`;
    if (CONTROL_CHARACTER.test(path)) return 'The path contains a control character.';
    if (path.includes('\\')) return 'Use forward slashes (/) in the path, not backslashes.';
    if (path.startsWith('/')) {
      return 'The path must be relative to the repository root, without a leading /.';
    }
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
