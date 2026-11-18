import type { LogRedaction } from './log-redaction.js';

/** Why no diff could be computed, as stored: redacted like the log, then cut. */
export class RunDiffUnavailableReason {
  /** As stored, after redaction (which can lengthen it). */
  static readonly MAX_LENGTH = 500;

  private constructor(readonly text: string) {}

  /** Redaction can lengthen the reason: it is cut after it, to what is stored. */
  static of(text: string, redaction: LogRedaction): RunDiffUnavailableReason {
    return new RunDiffUnavailableReason(
      redaction.text(text).slice(0, RunDiffUnavailableReason.MAX_LENGTH),
    );
  }
}
