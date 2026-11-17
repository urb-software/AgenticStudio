import { describe, expect, it } from 'vitest';
import { RunResume } from '../run-resume.js';

describe('RunResume', () => {
  it('takes a new Environment file snapshot for a Follow-up and a usage-limit resume inside one', () => {
    expect(RunResume.of('x', 'follow_up').takesNewEnvironmentFile(1)).toBe(true);
    expect(RunResume.of('x', 'bring_up_to_date').takesNewEnvironmentFile(1)).toBe(true);
    expect(RunResume.of('x', 'usage_limit').takesNewEnvironmentFile(1)).toBe(true);
    expect(RunResume.of('x', 'usage_limit').takesNewEnvironmentFile(0)).toBe(false);
    expect(RunResume.of('x', 'answer').takesNewEnvironmentFile(1)).toBe(false);
  });
});
