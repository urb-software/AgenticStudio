import { describe, expect, it } from 'vitest';
import {
  PreviewDisconnectRule,
  type PreviewDisconnectRuleFacts,
} from '../preview-disconnect-rule.js';

const next = (over: Partial<PreviewDisconnectRuleFacts>) =>
  PreviewDisconnectRule.create().next({
    operations: 3,
    buildEverClaimed: true,
    newest: { kind: 'build', status: 'succeeded' },
    activeOperations: 0,
    removalActive: false,
    ...over,
  });

describe('PreviewDisconnectRule', () => {
  it('forgets only the settings when there is no operation', () => {
    expect(next({ operations: 0, buildEverClaimed: false, newest: null })).toBe('forget_settings');
  });

  it('forgets everything when no build was ever claimed', () => {
    expect(next({ operations: 2, buildEverClaimed: false })).toBe('forget_everything');
  });

  it('forgets everything once a data removal succeeded and nothing is active', () => {
    expect(next({ newest: { kind: 'remove_data', status: 'succeeded' } })).toBe(
      'forget_everything',
    );
  });

  it('does not forget while something is still active after the removal', () => {
    expect(
      next({ newest: { kind: 'remove_data', status: 'succeeded' }, activeOperations: 1 }),
    ).toBe('request_removal');
  });

  it('requests a removal for what ran, again after a failed or unclaimed one', () => {
    expect(next({})).toBe('request_removal');
    expect(next({ newest: { kind: 'remove_data', status: 'failed' } })).toBe('request_removal');
    expect(next({ newest: { kind: 'stop', status: 'succeeded' } })).toBe('request_removal');
  });

  it('waits for a removal that is requested or claimed', () => {
    expect(
      next({
        newest: { kind: 'remove_data', status: 'claimed' },
        activeOperations: 1,
        removalActive: true,
      }),
    ).toBe('wait_for_removal');
  });
});
