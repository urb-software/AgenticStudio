import { describe, expect, it } from 'vitest';
import { MergeAvailabilityRule } from '../merge-availability-rule.js';

const GITHUB = 'https://github.com/acme/shop.git';

describe('MergeAvailabilityRule', () => {
  it('has no reason with the credential set and a GitHub remote', () => {
    const rule = MergeAvailabilityRule.of({ configured: true, allowFileRemotes: false });
    expect(rule.unavailableReason(GITHUB)).toBeNull();
  });

  it('says not_configured without the credential, even for an unsupported remote', () => {
    const rule = MergeAvailabilityRule.of({ configured: false, allowFileRemotes: false });
    expect(rule.unavailableReason(GITHUB)).toBe('not_configured');
    expect(rule.unavailableReason('https://gitlab.com/a/b.git')).toBe('not_configured');
  });

  it('says unsupported_host for another Git host', () => {
    const rule = MergeAvailabilityRule.of({ configured: true, allowFileRemotes: false });
    expect(rule.unavailableReason('https://gitlab.com/a/b.git')).toBe('unsupported_host');
  });

  it('accepts a file remote only where file remotes are allowed', () => {
    const remote = 'file:///srv/git/acme/shop.git';
    const allowed = MergeAvailabilityRule.of({ configured: true, allowFileRemotes: true });
    const refused = MergeAvailabilityRule.of({ configured: true, allowFileRemotes: false });
    expect(allowed.unavailableReason(remote)).toBeNull();
    expect(refused.unavailableReason(remote)).toBe('unsupported_host');
  });
});
