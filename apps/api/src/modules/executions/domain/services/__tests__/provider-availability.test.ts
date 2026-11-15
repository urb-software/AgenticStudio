import { describe, expect, it } from 'vitest';
import { providerAvailability, type WorkerStatus } from '../provider-availability.js';

// Issue #101: which providers Studio offers, from the latest agent worker status.
const NOW = new Date('2026-11-15T12:00:00.000Z');
const LEASE = 60;
const status = (providers: WorkerStatus['providers'], ageSeconds = 0): WorkerStatus => ({
  workerId: '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d',
  runner: 'cli',
  providers,
  reportedAt: new Date(NOW.getTime() - ageSeconds * 1000),
});

describe('providerAvailability', () => {
  it('offers the providers the worker enables, and names why the others are not', () => {
    expect(providerAvailability(status({ claude_code: true, codex: false }), NOW, LEASE)).toEqual([
      { id: 'claude_code', name: 'Claude Code', available: true },
      { id: 'codex', name: 'Codex', available: false, reason: 'Switched off on the agent worker' },
    ]);
  });

  it('offers nothing when no worker has reported', () => {
    expect(providerAvailability(undefined, NOW, LEASE)).toEqual([
      {
        id: 'claude_code',
        name: 'Claude Code',
        available: false,
        reason: 'No agent worker is connected',
      },
      { id: 'codex', name: 'Codex', available: false, reason: 'No agent worker is connected' },
    ]);
  });

  it('keeps a report for the lease, then counts it as no worker connected', () => {
    const both = { claude_code: true, codex: true };
    expect(providerAvailability(status(both, LEASE), NOW, LEASE).every((p) => p.available)).toBe(
      true,
    );
    expect(providerAvailability(status(both, LEASE + 1), NOW, LEASE)).toEqual([
      expect.objectContaining({ available: false, reason: 'No agent worker is connected' }),
      expect.objectContaining({ available: false, reason: 'No agent worker is connected' }),
    ]);
  });
});
