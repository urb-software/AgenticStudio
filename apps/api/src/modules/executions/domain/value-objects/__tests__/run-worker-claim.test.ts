import { describe, expect, it } from 'vitest';
import { RunWorkerClaim } from '../run-worker-claim.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');

describe('RunWorkerClaim', () => {
  it('starts held by nobody, with no session and no Environment file', () => {
    const claim = RunWorkerClaim.none();
    expect(claim.isHeld).toBe(false);
    expect(claim.hasSession).toBe(false);
    expect(claim.workingCopyRemoved).toBe(false);
    expect(claim.environmentFileSupplied).toBe(false);
    expect(claim.environmentFilePath).toBeNull();
  });

  it('knows which worker holds it, which held it last and whose report it took', () => {
    const claim = RunWorkerClaim.none().with({ claimedBy: 'w1', lastClaimedBy: 'w1' });
    expect(claim.isHeld).toBe(true);
    expect(claim.isHeldBy('w1')).toBe(true);
    expect(claim.isHeldBy('w2')).toBe(false);
    expect(claim.wasLastClaimedBy('w1')).toBe(true);
    expect(claim.wasLastClaimedBy('w2')).toBe(false);
    expect(claim.isReportedBy('w1')).toBe(true);

    const released = claim.with({ claimedBy: null, releasedBy: 'w1' });
    expect(released.isHeld).toBe(false);
    expect(released.isReportedBy('w1')).toBe(true);
    expect(released.isReportedBy('w2')).toBe(false);
    expect(released.wasLastClaimedBy('w1')).toBe(true);
  });

  it('has a session and a removed Working copy once recorded', () => {
    const claim = RunWorkerClaim.none().with({ sessionRef: 's-1', workingCopyRemovedAt: NOW });
    expect(claim.hasSession).toBe(true);
    expect(claim.workingCopyRemoved).toBe(true);
  });

  it('returns a new claim for a change and leaves the old one as it was', () => {
    const before = RunWorkerClaim.none();
    const after = before.with({ claimedBy: 'w1', heartbeatAt: NOW });

    expect(after).not.toBe(before);
    expect(before.claimedBy).toBeNull();
    expect(before.heartbeatAt).toBeNull();
    expect(after.heartbeatAt).toEqual(NOW);
  });

  it('maps to the stored fields and back', () => {
    const stored = {
      claimedBy: 'w1',
      lastClaimedBy: 'w1',
      releasedBy: null,
      heartbeatAt: NOW,
      sessionRef: 's-1',
      workingCopyRemovedAt: null,
      environmentFileSupplied: true,
      environmentFilePath: 'config/.env',
    };
    expect(RunWorkerClaim.restore(stored).toData()).toEqual(stored);
  });
});
