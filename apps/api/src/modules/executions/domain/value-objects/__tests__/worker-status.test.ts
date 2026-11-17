import { describe, expect, it } from 'vitest';
import { type RecordedWorkerStatus, WorkerStatus } from '../worker-status.js';

// Issue #167: what the agent worker's reported status knows: whether it is connected within the
// lease, and whether it offers a Provider.
const NOW = new Date('2026-11-15T12:00:00.000Z');
const LEASE = 60;
const at = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000);

const recorded = (overrides: Partial<RecordedWorkerStatus> = {}): RecordedWorkerStatus => ({
  workerId: '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d',
  reportedAt: at(0),
  runner: 'cli',
  providers: { claude_code: true, codex: false },
  ...overrides,
});

describe('WorkerStatus', () => {
  it('is connected when it reported within the lease, and exactly at its edge', () => {
    expect(WorkerStatus.restore(recorded({ reportedAt: at(0) })).isConnected(NOW, LEASE)).toBe(
      true,
    );
    expect(WorkerStatus.restore(recorded({ reportedAt: at(LEASE) })).isConnected(NOW, LEASE)).toBe(
      true,
    );
  });

  it('is not connected once the lease has passed', () => {
    expect(
      WorkerStatus.restore(recorded({ reportedAt: at(LEASE + 1) })).isConnected(NOW, LEASE),
    ).toBe(false);
  });

  it('knows who reported and when', () => {
    const status = WorkerStatus.restore(recorded({ reportedAt: at(5) }));

    expect(status.workerId).toBe('6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d');
    expect(status.reportedAt).toEqual(at(5));
  });

  it('offers a Provider that is switched on and has no reason against it', () => {
    const status = WorkerStatus.restore(recorded());

    expect(status.offers('claude_code')).toBe(true);
    expect(status.hasSwitchedOn('claude_code')).toBe(true);
    expect(status.reasonFor('claude_code')).toBeUndefined();
  });

  it('does not offer a Provider that is switched off', () => {
    const status = WorkerStatus.restore(recorded());

    expect(status.offers('codex')).toBe(false);
    expect(status.hasSwitchedOn('codex')).toBe(false);
  });

  it('does not offer a switched-on Provider the worker gave a reason against, and says it', () => {
    const status = WorkerStatus.restore(
      recorded({
        providers: { claude_code: true, codex: true },
        providerReasons: { codex: 'Unsupported CLI version' },
      }),
    );

    expect(status.hasSwitchedOn('codex')).toBe(true);
    expect(status.offers('codex')).toBe(false);
    expect(status.reasonFor('codex')).toBe('Unsupported CLI version');
    expect(status.offers('claude_code')).toBe(true);
  });

  describe('isWithinLease', () => {
    it('is true up to the lease and false after it, and false when never seen', () => {
      expect(WorkerStatus.isWithinLease(at(LEASE), NOW, LEASE)).toBe(true);
      expect(WorkerStatus.isWithinLease(at(LEASE + 1), NOW, LEASE)).toBe(false);
      expect(WorkerStatus.isWithinLease(undefined, NOW, LEASE)).toBe(false);
    });
  });
});
