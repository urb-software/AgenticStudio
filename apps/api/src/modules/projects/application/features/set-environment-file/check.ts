import { ENVIRONMENT_FILE_MAX_BYTES, environmentFilePathProblem } from '@agentic-studio/contracts';
import {
  InvalidEnvironmentFileContentError,
  InvalidEnvironmentFilePathError,
} from '../../../domain/value-objects/environment-file.js';

/** A UTF-16 surrogate without its pair: not encodable as UTF-8. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Checks a path and content the operator saves; returns the content's size in UTF-8 bytes.
 * Throws {@link InvalidEnvironmentFilePathError} or {@link InvalidEnvironmentFileContentError}.
 * Whether the path is tracked needs the repository and is checked by the caller.
 */
export function checkEnvironmentFile(path: string, content: string): { sizeBytes: number } {
  const problem = environmentFilePathProblem(path);
  if (problem !== null) throw new InvalidEnvironmentFilePathError(problem);
  if (LONE_SURROGATE.test(content)) {
    throw new InvalidEnvironmentFileContentError('The content is not valid UTF-8 text.');
  }
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  if (sizeBytes > ENVIRONMENT_FILE_MAX_BYTES) {
    throw new InvalidEnvironmentFileContentError(
      `The content is larger than ${ENVIRONMENT_FILE_MAX_BYTES / 1024} KiB.`,
    );
  }
  return { sizeBytes };
}
