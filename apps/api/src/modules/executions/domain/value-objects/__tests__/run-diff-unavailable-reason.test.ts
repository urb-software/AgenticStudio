import { describe, expect, it } from 'vitest';
import { LogRedaction, REDACTED } from '../log-redaction.js';
import { RunDiffUnavailableReason } from '../run-diff-unavailable-reason.js';

describe('RunDiffUnavailableReason', () => {
  it('redacts the reason and cuts it after the redaction', () => {
    const reason = RunDiffUnavailableReason.of(`${'abcd '.repeat(200)}`, LogRedaction.of(['abcd']));

    expect(reason.text).toHaveLength(RunDiffUnavailableReason.MAX_LENGTH);
    expect(reason.text.startsWith(REDACTED)).toBe(true);
  });
});
