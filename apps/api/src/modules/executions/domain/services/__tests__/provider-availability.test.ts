import { describe, expect, it } from 'vitest';
import { providerAvailability, type RecordedWorkerStatus } from '../provider-availability.js';

// Issue #101: which providers Studio offers, from the latest agent worker status.
const NOW = new Date('2026-11-15T12:00:00.000Z');
const LEASE = 60;
const status = (
  providers: RecordedWorkerStatus['providers'],
  ageSeconds = 0,
): RecordedWorkerStatus => ({
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

  it("shows the worker's reason for a switched-on provider it cannot run (Issue #105)", () => {
    const reported = {
      ...status({ claude_code: true, codex: false }),
      providerReasons: {
        claude_code: 'Claude Code 2.2.0 is not a supported version (>=2.1.325 <2.2.0).',
        // A reason never turns a switched-off provider into anything else.
        codex: 'not installed',
      },
    };

    expect(providerAvailability(reported, NOW, LEASE)).toEqual([
      {
        id: 'claude_code',
        name: 'Claude Code',
        available: false,
        reason: 'Claude Code 2.2.0 is not a supported version (>=2.1.325 <2.2.0).',
      },
      { id: 'codex', name: 'Codex', available: false, reason: 'Switched off on the agent worker' },
    ]);
  });
});
