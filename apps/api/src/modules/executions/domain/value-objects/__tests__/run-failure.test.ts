import { describe, expect, it } from 'vitest';
import { RunFailure } from '../run-failure.js';

describe('RunFailure', () => {
  it('cuts a reported detail to the contract limit', () => {
    const failure = RunFailure.of('agent_failed', 'x'.repeat(RunFailure.DETAIL_MAX_LENGTH + 50));

    expect(failure.detail).toHaveLength(RunFailure.DETAIL_MAX_LENGTH);
    expect(failure.code).toBe('agent_failed');
  });

  it('keeps a detail that fits as it is', () => {
    expect(RunFailure.of('unknown', 'short').detail).toBe('short');
  });

  it('does not cut a stored or self-worded detail', () => {
    const long = 'y'.repeat(RunFailure.DETAIL_MAX_LENGTH + 1);

    expect(RunFailure.restore({ code: 'unknown', detail: long }).detail).toBe(long);
  });
});
