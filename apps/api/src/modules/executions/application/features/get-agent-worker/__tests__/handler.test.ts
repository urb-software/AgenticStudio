import { describe, expect, it } from 'vitest';
import type { RecordedWorkerStatus } from '../../../../domain/value-objects/worker-status.js';
import { GetAgentWorkerHandler } from '../handler.js';

const T0 = new Date('2026-11-16T12:00:00.000Z');
const GIB = 1024 ** 3;
const DISK = {
  workingCopiesBytes: GIB,
  cachesBytes: GIB,
  keptRuns: 2,
  freeBytes: 40 * GIB,
  totalBytes: 100 * GIB,
  minFreeBytes: 10 * GIB,
};

function handler(status: Partial<RecordedWorkerStatus> | undefined, now = T0) {
  const full: RecordedWorkerStatus | undefined = status && {
    workerId: 'w',
    runner: 'cli',
    providers: { claude_code: true, codex: true },
    reportedAt: T0,
    ...status,
  };
  return new GetAgentWorkerHandler(
    { record: () => undefined, latest: () => full, lastSeen: () => full?.reportedAt },
    { now: () => now },
    { seconds: 60 },
  );
}

describe('GetAgentWorkerHandler (Issue #143)', () => {
  it('says nothing is connected before any report, and when the report is stale', () => {
    expect(handler(undefined).execute()).toEqual({ connected: false });
    expect(handler({ disk: DISK }, new Date(T0.getTime() + 61_000)).execute()).toEqual({
      connected: false,
    });
  });

  it('gives the figures and whether free space is below the threshold', () => {
    expect(handler({ disk: DISK }).execute()).toEqual({
      connected: true,
      disk: { ...DISK, low: false },
    });
    expect(handler({ disk: { ...DISK, freeBytes: 9 * GIB } }).execute().disk?.low).toBe(true);
  });

  it('never calls the space low with a threshold of zero', () => {
    const view = handler({ disk: { ...DISK, freeBytes: 0, minFreeBytes: 0 } }).execute();

    expect(view.disk?.low).toBe(false);
  });

  it('passes on that the figures are partial', () => {
    expect(handler({ disk: { ...DISK, partial: true } }).execute().disk?.partial).toBe(true);
  });

  it('gives no figures before the worker measured', () => {
    expect(handler({}).execute()).toEqual({ connected: true });
  });
});
