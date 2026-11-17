import { describe, expect, it } from 'vitest';
import {
  DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS,
  DeployKeySweepPolicy,
} from '../deploy-key-sweep-policy.js';

describe('DeployKeySweepPolicy', () => {
  it('has a grace period of one hour by default', () => {
    expect(DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS).toBe(60 * 60 * 1000);
    expect(DeployKeySweepPolicy.of().gracePeriodMs).toBe(DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS);
  });

  it('takes a shorter grace period, none included', () => {
    expect(DeployKeySweepPolicy.of(0).gracePeriodMs).toBe(0);
    expect(DeployKeySweepPolicy.of(1000).gracePeriodMs).toBe(1000);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses the grace period %s', (ms) => {
    expect(() => DeployKeySweepPolicy.of(ms)).toThrow(RangeError);
  });

  it('selects the old stored keys no Repository references', () => {
    expect(DeployKeySweepPolicy.of().orphans(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });

  it('never selects a referenced key, and ignores references to keys that are not stored', () => {
    expect(DeployKeySweepPolicy.of().orphans(['a', 'b'], new Set(['a', 'b', 'gone']))).toEqual([]);
  });

  it('selects nothing from no stored keys, and everything when nothing is referenced', () => {
    const policy = DeployKeySweepPolicy.of();

    expect(policy.orphans([], ['a'])).toEqual([]);
    expect(policy.orphans(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});
