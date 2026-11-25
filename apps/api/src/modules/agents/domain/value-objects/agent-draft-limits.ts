import { DraftTooLargeError, DraftTooManyFilesError } from '../errors/agent-draft-errors.js';
import type { AgentDraftFile } from './agent-draft-file.js';

/** What the whole Draft may hold; the per-file limit is {@link AgentDraftFileSize}'s. */
export class AgentDraftLimits {
  static readonly MAX_TOTAL_BYTES = 10 * 1024 * 1024;
  static readonly MAX_FILES = 200;

  private constructor(
    readonly totalBytes: number,
    readonly files: number,
  ) {}

  static create(): AgentDraftLimits {
    return new AgentDraftLimits(AgentDraftLimits.MAX_TOTAL_BYTES, AgentDraftLimits.MAX_FILES);
  }

  /** Throws {@link DraftTooManyFilesError} and {@link DraftTooLargeError}. */
  assertFits(files: readonly AgentDraftFile[]): void {
    if (files.length > this.files) throw new DraftTooManyFilesError(this.files);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > this.totalBytes) throw new DraftTooLargeError(total, this.totalBytes);
  }
}
