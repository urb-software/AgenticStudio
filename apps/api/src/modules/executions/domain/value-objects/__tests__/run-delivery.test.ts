import { describe, expect, it } from 'vitest';
import { RunDelivery } from '../run-delivery.js';

const PULL_REQUEST = { url: 'https://github.com/a/b/pull/7', number: 7 };

describe('RunDelivery', () => {
  it('starts with nothing delivered, based on the integration branch', () => {
    const delivery = RunDelivery.start('dev');
    expect(delivery.integrationBranch).toBe('dev');
    expect(delivery.state).toBeNull();
    expect(delivery.pullRequest).toBeNull();
    expect(delivery.pushedCommit).toBeNull();
    expect(delivery.requested).toBe(false);
    expect(delivery.hasPullRequest).toBe(false);
  });

  it('maps to the stored names and back', () => {
    const stored = {
      integrationBranch: 'main',
      delivery: 'delivered' as const,
      pullRequest: PULL_REQUEST,
      deliveryRequested: true,
      pushedCommit: 'a'.repeat(40),
    };
    const delivery = RunDelivery.restore(stored);

    expect(delivery.state).toBe('delivered');
    expect(delivery.requested).toBe(true);
    expect(delivery.hasPullRequest).toBe(true);
    expect(delivery.toStored()).toEqual(stored);
  });

  it('returns a new delivery for a change and leaves the old one as it was', () => {
    const before = RunDelivery.start('dev');
    const after = before.with({ deliveryRequested: true, delivery: 'failed' });

    expect(after).not.toBe(before);
    expect(before.requested).toBe(false);
    expect(before.state).toBeNull();
    expect(after.requested).toBe(true);
    expect(after.state).toBe('failed');
    expect(after.integrationBranch).toBe('dev');
  });

  it('sets the fields of a delivery outcome; one without a pull request keeps the Run’s', () => {
    expect(
      RunDelivery.start('dev').outcomePatch({
        outcome: 'delivered',
        pullRequest: PULL_REQUEST,
        pushedCommit: 'b'.repeat(40),
      }),
    ).toEqual({
      delivery: 'delivered',
      pullRequest: PULL_REQUEST,
      pushedCommit: 'b'.repeat(40),
    });
    expect(RunDelivery.start('dev').outcomePatch({ outcome: 'none' })).toEqual({
      delivery: 'none',
    });
    expect(RunDelivery.start('dev').outcomePatch({ outcome: 'none', branchPushed: true })).toEqual({
      delivery: 'none',
    });
  });

  it('copies the pull request of an outcome', () => {
    const outcome = { outcome: 'delivered' as const, pullRequest: { ...PULL_REQUEST } };
    const patch = RunDelivery.start('dev').outcomePatch(outcome);
    expect(patch.pullRequest).toEqual(PULL_REQUEST);
    expect(patch.pullRequest).not.toBe(outcome.pullRequest);
  });
});
