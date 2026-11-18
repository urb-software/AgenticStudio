import type { LookupFailureCode } from './lookup-failure-code.js';

/** Redacted before it is stored. */
export class LookupFailure {
  static readonly RETRY_DELAY_MAX_SECONDS = 60 * 60;

  private constructor(
    readonly code: LookupFailureCode,
    readonly error: string,
    readonly retryAfterSeconds: number | undefined,
  ) {}

  static of(input: {
    code: LookupFailureCode;
    error: string;
    retryAfterSeconds?: number | undefined;
  }): LookupFailure {
    return new LookupFailure(input.code, input.error, input.retryAfterSeconds);
  }

  get retryDelaySeconds(): number | null {
    if (this.code !== 'rate_limited') return null;
    return Math.min(
      Math.max(this.retryAfterSeconds ?? 60, 1),
      LookupFailure.RETRY_DELAY_MAX_SECONDS,
    );
  }
}
