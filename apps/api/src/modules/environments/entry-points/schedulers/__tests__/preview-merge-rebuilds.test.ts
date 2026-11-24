import { describe, expect, it, vi } from 'vitest';
import type {
  ReleaseMergeRebuildsHandler,
  ReleaseMergeRebuildsResult,
} from '../../../application/features/release-merge-rebuilds/handler.js';
import { PreviewMergeRebuildsScheduler } from '../preview-merge-rebuilds.js';

const handler = (execute: () => Promise<ReleaseMergeRebuildsResult>) =>
  ({ execute }) as unknown as ReleaseMergeRebuildsHandler;
const NOTHING = { built: 0, dropped: 0, failed: 0 };

describe('PreviewMergeRebuildsScheduler', () => {
  it('releases on a timer from the start until shutdown', async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn(() => Promise.resolve(NOTHING));
      const timed = new PreviewMergeRebuildsScheduler(handler(execute), {
        enabled: true,
        intervalMs: 5000,
      });

      timed.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(5000);
      expect(execute).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(execute).toHaveBeenCalledTimes(2);

      timed.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts no timer while it is turned off', async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn(() => Promise.resolve(NOTHING));
      const off = new PreviewMergeRebuildsScheduler(handler(execute), {
        enabled: false,
        intervalMs: 1000,
      });

      off.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a failed release and runs again', async () => {
    const execute = vi
      .fn<() => Promise<ReleaseMergeRebuildsResult>>()
      .mockRejectedValueOnce(new Error('database is down'))
      .mockResolvedValue(NOTHING);
    const scheduler = new PreviewMergeRebuildsScheduler(handler(execute), {
      enabled: true,
      intervalMs: 5000,
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();
    await scheduler.tick();

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not overlap two releases', async () => {
    let finish: (result: ReleaseMergeRebuildsResult) => void = () => undefined;
    const execute = vi.fn(
      () =>
        new Promise<ReleaseMergeRebuildsResult>((resolve) => {
          finish = resolve;
        }),
    );
    const scheduler = new PreviewMergeRebuildsScheduler(handler(execute), {
      enabled: true,
      intervalMs: 5000,
    });

    const first = scheduler.tick();
    await scheduler.tick();
    finish(NOTHING);
    await first;

    expect(execute).toHaveBeenCalledTimes(1);
  });
});
