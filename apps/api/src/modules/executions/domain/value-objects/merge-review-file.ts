import type { LogRedaction } from './log-redaction.js';
import type { RunDiffFileStatus } from './run-diff-file-status.js';

export interface MergeReviewFileInput {
  path: string;
  previousPath?: string;
  status: RunDiffFileStatus;
  binary?: true;
  patch?: string;
  cut: boolean;
}

export type MergeReviewFileData = MergeReviewFileInput;

/**
 * One file of a merge review. Its patch is the repository's text: redacted with the Run's secret
 * values before it is kept, and left out (the file is `cut`) when redaction made it longer than
 * the per-file limit.
 */
export class MergeReviewFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: RunDiffFileStatus;
  readonly binary?: true;
  readonly patch?: string;
  readonly cut: boolean;

  private constructor(data: MergeReviewFileData) {
    this.path = data.path;
    if (data.previousPath !== undefined) this.previousPath = data.previousPath;
    this.status = data.status;
    if (data.binary) this.binary = true;
    if (data.patch !== undefined) this.patch = data.patch;
    this.cut = data.cut;
  }

  /** Redacts the patch, then keeps it only if it still fits `filePatchMaxBytes`. */
  static load(
    raw: MergeReviewFileInput,
    redaction: LogRedaction,
    filePatchMaxBytes: number,
  ): MergeReviewFile {
    const { patch, ...rest } = raw;
    if (patch === undefined) return new MergeReviewFile(rest);
    const redacted = redaction.text(patch);
    if (new TextEncoder().encode(redacted).length > filePatchMaxBytes) {
      return new MergeReviewFile({ ...rest, cut: true });
    }
    return new MergeReviewFile({ ...rest, patch: redacted });
  }

  static restore(data: MergeReviewFileData): MergeReviewFile {
    return new MergeReviewFile(data);
  }

  toData(): MergeReviewFileData {
    return {
      path: this.path,
      ...(this.previousPath === undefined ? {} : { previousPath: this.previousPath }),
      status: this.status,
      ...(this.binary ? { binary: true as const } : {}),
      ...(this.patch === undefined ? {} : { patch: this.patch }),
      cut: this.cut,
    };
  }

  /** The same file without its patch, listed as cut. */
  withoutPatch(): MergeReviewFile {
    const { patch, ...rest } = this.toData();
    void patch;
    return new MergeReviewFile({ ...rest, cut: true });
  }

  /** What the file takes in storage, as JSON. */
  get storedBytes(): number {
    return new TextEncoder().encode(JSON.stringify(this.toData())).length;
  }
}
