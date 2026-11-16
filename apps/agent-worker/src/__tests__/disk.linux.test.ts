import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiskMonitor, LowFreeSpaceError } from '../disk.js';

// Issue #143: what the worker measures of its disk and how it refuses new Runs, on a real
// directory tree with the file system's free space faked. Linux only, like the worker.

const GIB = 1024 ** 3;

describe.skipIf(process.platform !== 'linux')('DiskMonitor', () => {
  let dataDir: string;
  let now: number;
  let freeBytes: number;
  let errors: string[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'studio-disk-'));
    mkdirSync(join(dataDir, 'runs'));
    mkdirSync(join(dataDir, 'cache'));
    now = Date.parse('2026-11-16T12:00:00.000Z');
    freeBytes = 50 * GIB;
    errors = [];
  });

  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const monitor = (minFreeGib = 10) =>
    new DiskMonitor({
      dataDir,
      minFreeBytes: minFreeGib * GIB,
      now: () => new Date(now),
      logger: { error: (message) => errors.push(message) },
      space: async () => ({ freeBytes, totalBytes: 200 * GIB }),
    });

  function runDirectory(bytes: number): string {
    const runId = randomUUID();
    mkdirSync(join(dataDir, 'runs', runId, 'repo'), { recursive: true });
    writeFileSync(join(dataDir, 'runs', runId, 'repo', 'file.bin'), Buffer.alloc(bytes));
    return runId;
  }

  it('reports what Working copies and caches hold, the Runs kept and the free space', async () => {
    runDirectory(1000);
    runDirectory(2000);
    mkdirSync(join(dataDir, 'runs', 'not-a-run'));
    mkdirSync(join(dataDir, 'cache', 'project.git'));
    writeFileSync(join(dataDir, 'cache', 'project.git', 'pack'), Buffer.alloc(500));
    const disk = monitor();

    expect(disk.snapshot()).toBeUndefined();
    await disk.settled();

    expect(disk.snapshot()).toEqual({
      workingCopiesBytes: 3000,
      cachesBytes: 500,
      keptRuns: 2,
      freeBytes: 50 * GIB,
      totalBytes: 200 * GIB,
      minFreeBytes: 10 * GIB,
    });
  });

  it('counts a file linked from a Working copy and the cache once (a local clone shares objects)', async () => {
    const runId = runDirectory(10);
    writeFileSync(join(dataDir, 'cache', 'object'), Buffer.alloc(4000));
    linkSync(join(dataDir, 'cache', 'object'), join(dataDir, 'runs', runId, 'repo', 'object'));
    const disk = monitor();

    disk.snapshot();
    await disk.settled();

    expect(disk.snapshot()).toMatchObject({ workingCopiesBytes: 4010, cachesBytes: 0 });
  });

  it('never follows a symlink out of the data directory', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'studio-disk-outside-'));
    try {
      writeFileSync(join(outside, 'big'), Buffer.alloc(100_000));
      const runId = runDirectory(10);
      symlinkSync(outside, join(dataDir, 'runs', runId, 'repo', 'link'));
      const disk = monitor();

      disk.snapshot();
      await disk.settled();

      expect(disk.snapshot()?.workingCopiesBytes).toBeLessThan(1000);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('measures at most every ten minutes', async () => {
    const runId = runDirectory(1000);
    const disk = monitor();
    disk.snapshot();
    await disk.settled();
    writeFileSync(join(dataDir, 'runs', runId, 'repo', 'more'), Buffer.alloc(1000));

    now += 9 * 60_000;
    disk.snapshot();
    await disk.settled();
    expect(disk.snapshot()?.workingCopiesBytes).toBe(1000);

    now += 61_000;
    disk.snapshot();
    await disk.settled();
    expect(disk.snapshot()?.workingCopiesBytes).toBe(2000);
  });

  it('reports no Runs and no bytes before the first Run', async () => {
    rmSync(join(dataDir, 'runs'), { recursive: true });
    const disk = monitor();

    disk.snapshot();
    await disk.settled();

    expect(disk.snapshot()).toMatchObject({ workingCopiesBytes: 0, keptRuns: 0 });
  });

  describe('free-space guard', () => {
    it('lets a new Run be prepared while the free space is at or above the threshold', async () => {
      freeBytes = 10 * GIB;

      await expect(monitor(10).assertEnoughFreeSpace()).resolves.toBeUndefined();
    });

    it('refuses below the threshold, naming the free space and the threshold', async () => {
      freeBytes = 4.5 * GIB;

      const failure = await monitor(10)
        .assertEnoughFreeSpace()
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(LowFreeSpaceError);
      expect((failure as LowFreeSpaceError).detail).toBe(
        "The agent worker's disk has 4.5 GiB free, below the 10.0 GiB it keeps free; no new run is prepared until space is freed.",
      );
    });

    it('reads the free space at once, not from the last measurement', async () => {
      const disk = monitor(10);
      disk.snapshot();
      await disk.settled();
      freeBytes = 1 * GIB;

      await expect(disk.assertEnoughFreeSpace()).rejects.toBeInstanceOf(LowFreeSpaceError);
    });

    it('is off with a threshold of zero', async () => {
      freeBytes = 0;

      await expect(monitor(0).assertEnoughFreeSpace()).resolves.toBeUndefined();
    });

    it('does not stop work when the disk cannot be read, and logs it', async () => {
      const disk = new DiskMonitor({
        dataDir,
        minFreeBytes: 10 * GIB,
        now: () => new Date(now),
        logger: { error: (message) => errors.push(message) },
        space: () => Promise.reject(new Error('statfs failed')),
      });

      await expect(disk.assertEnoughFreeSpace()).resolves.toBeUndefined();
      expect(errors[0]).toContain('statfs failed');
    });
  });
});
