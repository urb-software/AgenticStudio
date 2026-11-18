import { describe, expect, it } from 'vitest';
import { LookupFailure, STORED_RETRY_DELAY_MAX_SECONDS } from '../run-lookup.js';

describe('LookupFailure.retryDelaySeconds', () => {
  it('retries only a rate limit, after what the Git host asked, bounded', () => {
    expect(
      LookupFailure.of({ code: 'rate_limited', error: 'x', retryAfterSeconds: 90 })
        .retryDelaySeconds,
    ).toBe(90);
    expect(LookupFailure.of({ code: 'rate_limited', error: 'x' }).retryDelaySeconds).toBe(60);
    expect(
      LookupFailure.of({ code: 'rate_limited', error: 'x', retryAfterSeconds: 999_999 })
        .retryDelaySeconds,
    ).toBe(STORED_RETRY_DELAY_MAX_SECONDS);
    expect(LookupFailure.of({ code: 'failed', error: 'x' }).retryDelaySeconds).toBeNull();
    expect(LookupFailure.of({ code: 'scope_mismatch', error: 'x' }).retryDelaySeconds).toBeNull();
  });
});
