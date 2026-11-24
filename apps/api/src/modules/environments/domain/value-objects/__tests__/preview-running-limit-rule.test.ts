import { describe, expect, it } from 'vitest';
import { PreviewRunningLimitRule } from '../preview-running-limit-rule.js';

const rule = PreviewRunningLimitRule.create();
const change = (kind: string, status = 'succeeded') => ({ kind, status });

describe('PreviewRunningLimitRule', () => {
  it('takes a place for a Preview that runs', () => {
    const facts = { runningChange: change('build'), buildActive: false };
    expect(rule.occupies(facts)).toBe(true);
    expect(rule.state(facts)).toBe('running');
  });

  it('takes a place for an active build, which shows as building even over a running one', () => {
    expect(rule.state({ runningChange: null, buildActive: true })).toBe('building');
    expect(rule.state({ runningChange: change('build'), buildActive: true })).toBe('building');
  });

  it.each(['stop', 'remove_data', 'state'])('takes none after a %s', (kind) => {
    const facts = { runningChange: change(kind), buildActive: false };
    expect(rule.occupies(facts)).toBe(false);
    expect(rule.state(facts)).toBeNull();
  });

  it('takes none for a Project that never ran', () => {
    expect(rule.occupies({ runningChange: null, buildActive: false })).toBe(false);
  });
});
