import { describe, expect, it, vi } from 'vitest';
import type { SweepPreviewOperationsHandler } from '../../../application/features/sweep-preview-operations/handler.js';
import { PreviewSweepsScheduler, previewSweepIntervalMs } from '../preview-sweeps.js';

const handler = (execute: () => Promise<{ releasedSnapshots: number; unclaimed: number }>) =>
  ({ execute }) as unknown as SweepPreviewOperationsHandler;

const scheduler = (
  leaseSeconds: number,
  sweep = handler(() => Promise.resolve({ releasedSnapshots: 0, unclaimed: 0 })),
) => new PreviewSweepsScheduler(sweep, { intervalMs: previewSweepIntervalMs(leaseSeconds) });

describe('PreviewSweepsScheduler', () => {
  it('sweeps every 30 seconds, or every half lease when that is shorter', () => {
    expect(previewSweepIntervalMs(60)).toBe(30_000);
    expect(previewSweepIntervalMs(600)).toBe(30_000);
    expect(previewSweepIntervalMs(20)).toBe(10_000);
    expect(previewSweepIntervalMs(10)).toBe(5_000);
  });

  it('runs the sweep on a timer from the start until shutdown', async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn(() => Promise.resolve({ releasedSnapshots: 0, unclaimed: 0 }));
      const timed = scheduler(60, handler(execute));

      timed.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(execute).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(execute).toHaveBeenCalledTimes(2);

      timed.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a failed sweep and runs again', async () => {
    const execute = vi
      .fn<() => Promise<{ releasedSnapshots: number; unclaimed: number }>>()
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue({ releasedSnapshots: 1, unclaimed: 1 });
    const timed = scheduler(60, handler(execute));

    await expect(timed.tick()).resolves.toBeUndefined();
    await expect(timed.tick()).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not start a sweep while the last one still runs', async () => {
    let release: () => void = () => undefined;
    const execute = vi.fn(
      () =>
        new Promise<{ releasedSnapshots: number; unclaimed: number }>((resolve) => {
          release = () => resolve({ releasedSnapshots: 0, unclaimed: 0 });
        }),
    );
    const timed = scheduler(60, handler(execute));

    const first = timed.tick();
    await timed.tick();
    release();
    await first;

    expect(execute).toHaveBeenCalledTimes(1);
  });
});
