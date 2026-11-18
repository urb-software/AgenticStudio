import { describe, expect, it } from 'vitest';
import { type RecordedWorkerStatus, WorkerStatus } from '../worker-status.js';

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

describe('WorkerStatus.providerAvailability', () => {
  it('offers the providers the worker enables, and names why the others are not', () => {
    expect(
      WorkerStatus.providerAvailability(status({ claude_code: true, codex: false }), NOW, LEASE),
    ).toEqual([
      { id: 'claude_code', name: 'Claude Code', available: true },
      { id: 'codex', name: 'Codex', available: false, reason: 'Switched off on the agent worker' },
    ]);
  });

  it('offers nothing when no worker has reported', () => {
    expect(WorkerStatus.providerAvailability(undefined, NOW, LEASE)).toEqual([
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
    expect(
      WorkerStatus.providerAvailability(status(both, LEASE), NOW, LEASE).every((p) => p.available),
    ).toBe(true);
    expect(WorkerStatus.providerAvailability(status(both, LEASE + 1), NOW, LEASE)).toEqual([
      expect.objectContaining({ available: false, reason: 'No agent worker is connected' }),
      expect.objectContaining({ available: false, reason: 'No agent worker is connected' }),
    ]);
  });

  it("shows the worker's reason for a switched-on provider it cannot run (Issue #105)", () => {
    const reported = {
      ...status({ claude_code: true, codex: false }),
      providerReasons: {
        claude_code: 'Claude Code 2.2.0 is not a supported version (>=2.1.325 <2.2.0).',
        codex: 'not installed',
      },
    };

    expect(WorkerStatus.providerAvailability(reported, NOW, LEASE)).toEqual([
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
