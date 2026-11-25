import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BASE_RULES } from '../index.js';

describe('BASE_RULES', () => {
  // The text moved here from the agent worker without a change; a change needs a new version.
  it('keeps the text and the version it had when it moved', () => {
    expect(BASE_RULES.version).toBe('2026-11-19.1');
    expect(createHash('sha256').update(BASE_RULES.text).digest('hex')).toBe(
      '85152300a476ebf8170ebc1f051b9dabf72191b5862062e6504cc2548fc01fb8',
    );
  });

  it('is versioned as <date>.<n>', () => {
    expect(BASE_RULES.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});
