import { describe, expect, it } from 'vitest';
import { LogRedaction } from '../log-redaction.js';
import { LookupFailure } from '../lookup-failure.js';

describe('LookupFailure.retryDelaySeconds', () => {
  it('retries only a rate limit, after what the Git host asked, bounded', () => {
    expect(
      LookupFailure.of(
        { code: 'rate_limited', error: 'x', retryAfterSeconds: 90 },
        LogRedaction.NONE,
      ).retryDelaySeconds,
    ).toBe(90);
    expect(
      LookupFailure.of({ code: 'rate_limited', error: 'x' }, LogRedaction.NONE).retryDelaySeconds,
    ).toBe(60);
    expect(
      LookupFailure.of(
        { code: 'rate_limited', error: 'x', retryAfterSeconds: 999_999 },
        LogRedaction.NONE,
      ).retryDelaySeconds,
    ).toBe(LookupFailure.RETRY_DELAY_MAX_SECONDS);
    expect(
      LookupFailure.of({ code: 'failed', error: 'x' }, LogRedaction.NONE).retryDelaySeconds,
    ).toBeNull();
    expect(
      LookupFailure.of({ code: 'scope_mismatch', error: 'x' }, LogRedaction.NONE).retryDelaySeconds,
    ).toBeNull();
  });
});
