import type { LogRedaction } from './log-redaction.js';
import type { LookupFailureCode } from './lookup-failure-code.js';

/** Redacted before it is stored. */
export class LookupFailure {
  static readonly RETRY_DELAY_MAX_SECONDS = 60 * 60;

  /** The worker protocol's limit is pinned to this one by a test. */
  static readonly ERROR_MAX_LENGTH = 500;

  private constructor(
    readonly code: LookupFailureCode,
    readonly error: string,
    readonly retryAfterSeconds: number | undefined,
  ) {}

  static of(
    input: {
      code: LookupFailureCode;
      error: string;
      retryAfterSeconds?: number | undefined;
    },
    redaction: LogRedaction,
  ): LookupFailure {
    return new LookupFailure(
      input.code,
      redaction.text(input.error).slice(0, LookupFailure.ERROR_MAX_LENGTH),
      input.retryAfterSeconds,
    );
  }

  get retryDelaySeconds(): number | null {
    if (this.code !== 'rate_limited') return null;
    return Math.min(
      Math.max(this.retryAfterSeconds ?? 60, 1),
      LookupFailure.RETRY_DELAY_MAX_SECONDS,
    );
  }
}
