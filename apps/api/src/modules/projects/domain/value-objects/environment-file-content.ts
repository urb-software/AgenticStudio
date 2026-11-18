import { InvalidEnvironmentFileContentError } from '../errors/environment-file-errors.js';

const MAX_BYTES = 64 * 1024;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The text of an Environment file, as an operator may save it; never logged or returned. */
export class EnvironmentFileContent {
  /** Largest content, in UTF-8 bytes; the worker protocol's limit is pinned to it by a test. */
  static readonly MAX_BYTES = MAX_BYTES;

  private constructor(
    readonly value: string,
    readonly sizeBytes: number,
  ) {}

  /** Throws {@link InvalidEnvironmentFileContentError}. */
  static of(content: string): EnvironmentFileContent {
    if (LONE_SURROGATE.test(content)) {
      throw new InvalidEnvironmentFileContentError('The content is not valid UTF-8 text.');
    }
    const sizeBytes = new TextEncoder().encode(content).length;
    if (sizeBytes > MAX_BYTES) {
      throw new InvalidEnvironmentFileContentError(
        `The content is larger than ${MAX_BYTES / 1024} KiB.`,
      );
    }
    return new EnvironmentFileContent(content, sizeBytes);
  }
}
