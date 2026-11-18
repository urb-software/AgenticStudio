import { describe, expect, it } from 'vitest';
import { type RecordedWorkerStatus, WorkerStatus } from '../worker-status.js';

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

  it('has a Provider switched on and no reason against it', () => {
    const status = WorkerStatus.restore(recorded());
    expect(status.hasSwitchedOn('claude_code')).toBe(true);
    expect(status.reasonFor('claude_code')).toBeUndefined();
  });

  it('has a Provider switched off', () => {
    const status = WorkerStatus.restore(recorded());
    expect(status.hasSwitchedOn('codex')).toBe(false);
  });

  it('gives a reason against a switched-on Provider it cannot run, and says it', () => {
    const status = WorkerStatus.restore(
      recorded({
        providers: { claude_code: true, codex: true },
        providerReasons: { codex: 'Unsupported CLI version' },
      }),
    );

    expect(status.hasSwitchedOn('codex')).toBe(true);
    expect(status.reasonFor('codex')).toBe('Unsupported CLI version');
  });

  describe('isWithinLease', () => {
    it('is true up to the lease and false after it, and false when never seen', () => {
      expect(WorkerStatus.isWithinLease(at(LEASE), NOW, LEASE)).toBe(true);
      expect(WorkerStatus.isWithinLease(at(LEASE + 1), NOW, LEASE)).toBe(false);
      expect(WorkerStatus.isWithinLease(undefined, NOW, LEASE)).toBe(false);
    });
  });
});
