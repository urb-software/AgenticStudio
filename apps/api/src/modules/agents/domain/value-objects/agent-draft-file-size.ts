import { MAX_FILE_BYTES } from '@agentic-studio/agent-definitions';

/** A file of the Draft is over the per-file limit. */
export class DraftFileTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`The file is ${size} bytes, over the limit of ${limit} bytes.`);
    this.name = 'DraftFileTooLargeError';
  }
}

/** The size of one file of the Draft, within the shared package's per-file limit. */
export class AgentDraftFileSize {
  static readonly MAX_BYTES = MAX_FILE_BYTES;

  private constructor(readonly bytes: number) {}

  /** Throws {@link DraftFileTooLargeError}. */
  static of(bytes: number): AgentDraftFileSize {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('A size is whole bytes.');
    if (bytes > AgentDraftFileSize.MAX_BYTES) {
      throw new DraftFileTooLargeError(bytes, AgentDraftFileSize.MAX_BYTES);
    }
    return new AgentDraftFileSize(bytes);
  }
}
