import { describe, expect, it } from 'vitest';
import type { EnvironmentFileSnapshotFacts } from '../environment-file-snapshot-facts.js';
import { EnvironmentFileSnapshotRule } from '../environment-file-snapshot-rule.js';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const rule = EnvironmentFileSnapshotRule.at(NOW, 7);
const facts = (patch: Partial<EnvironmentFileSnapshotFacts>): EnvironmentFileSnapshotFacts => ({
  isFinal: true,
  keepsForRetry: false,
  deliveryRequested: false,
  finishedAt: NOW,
  ...patch,
});

describe('EnvironmentFileSnapshotRule', () => {
  it('counts the retention period back from now', () => {
    expect(rule.retryableFinishedBefore).toEqual(new Date('2026-11-11T12:00:00.000Z'));
  });

  it('takes the retention cutoff as given', () => {
    const cutoff = new Date('2026-11-01T00:00:00.000Z');
    expect(EnvironmentFileSnapshotRule.finishedBefore(cutoff).retryableFinishedBefore).toEqual(
      cutoff,
    );
  });

  it('releases the snapshot of a final Run that cannot be retried', () => {
    expect(rule.releasable(facts({}))).toBe(true);
    expect(rule.releasable(facts({ isFinal: false }))).toBe(false);
  });

  it('keeps a retryable Run while a retry is requested or the retention period lasts', () => {
    const retryable = { keepsForRetry: true };
    expect(rule.releasable(facts({ ...retryable, finishedAt: NOW }))).toBe(false);
    expect(rule.releasable(facts({ ...retryable, finishedAt: rule.retryableFinishedBefore }))).toBe(
      false,
    );
    expect(
      rule.releasable(
        facts({ ...retryable, finishedAt: new Date(rule.retryableFinishedBefore.getTime() - 1) }),
      ),
    ).toBe(true);
    expect(
      rule.releasable(
        facts({
          ...retryable,
          deliveryRequested: true,
          finishedAt: new Date(rule.retryableFinishedBefore.getTime() - 1),
        }),
      ),
    ).toBe(false);
  });
});
