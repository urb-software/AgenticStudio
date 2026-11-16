import type { WorkerDisk } from '@agentic-studio/contracts';
import type { BigIntStats } from 'node:fs';
import { lstat, readdir, statfs } from 'node:fs/promises';
import { posix } from 'node:path';
import { cachesDirectory, isUuid, runsDirectory } from './run-layout.js';

/** How often the disk is measured at most (Issue #143). */
export const DISK_MEASURE_INTERVAL_MS = 10 * 60_000;

/** Why no new Run is prepared: the free space is below the threshold. Safe to show (no path). */
export class LowFreeSpaceError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'LowFreeSpaceError';
  }
}

/** The file system's free and total bytes (for unprivileged use) at a path. */
export interface FileSystemSpace {
  freeBytes: number;
  totalBytes: number;
}

export interface DiskMonitorOptions {
  /** The worker's data directory (`<dataDir>/runs`, `<dataDir>/cache`). */
  dataDir: string;
  /** Free space below this many bytes: no new Run is prepared (`STUDIO_WORKER_MIN_FREE_GB`). */
  minFreeBytes: number;
  now: () => Date;
  logger: { error(message: string): void };
  /** Test seams. */
  space?: (path: string) => Promise<FileSystemSpace>;
  measureIntervalMs?: number;
}

async function fileSystemSpace(path: string): Promise<FileSystemSpace> {
  const stats = await statfs(path);
  return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
}

const GIB = 1024 ** 3;

function gib(bytes: number): string {
  return (bytes / GIB).toFixed(1);
}

/**
 * The disk the worker keeps Working copies and caches on (Issue #143). `snapshot()` is the figures
 * of the latest measurement, taken at most every ten minutes in the background (walking a
 * Working copy tree is not free), for the worker's status report. `assertEnoughFreeSpace()`
 * reads the free space right now, so a new Run is refused the moment the disk is short rather
 * than up to ten minutes later.
 */
export class DiskMonitor {
  private figures: WorkerDisk | undefined;
  private measuredAt = Number.NEGATIVE_INFINITY;
  private measuring: Promise<void> | undefined;

  constructor(private readonly options: DiskMonitorOptions) {}

  /** The latest figures, or `undefined` until the first measurement finished. */
  snapshot(): WorkerDisk | undefined {
    const interval = this.options.measureIntervalMs ?? DISK_MEASURE_INTERVAL_MS;
    if (this.options.now().getTime() - this.measuredAt >= interval) this.startMeasuring();
    return this.figures;
  }

  /** Resolves when a measurement under way finished (tests, shutdown). */
  async settled(): Promise<void> {
    await this.measuring;
  }

  /** Throws {@link LowFreeSpaceError} when the free space is below the threshold. */
  async assertEnoughFreeSpace(): Promise<void> {
    if (this.options.minFreeBytes <= 0) return;
    let free: number;
    try {
      free = (await (this.options.space ?? fileSystemSpace)(this.options.dataDir)).freeBytes;
    } catch (error) {
      // A guard that cannot read the disk does not stop work the disk may well allow.
      this.options.logger.error(`Reading the free disk space failed: ${String(error)}`);
      return;
    }
    if (free < this.options.minFreeBytes) {
      throw new LowFreeSpaceError(
        `The agent worker's disk has ${gib(free)} GiB free, below the ${gib(this.options.minFreeBytes)} GiB it keeps free; no new run is prepared until space is freed.`,
      );
    }
  }

  private startMeasuring(): void {
    if (this.measuring) return;
    // Counted from the start, so a failing measurement is not retried on every status report.
    this.measuredAt = this.options.now().getTime();
    this.measuring = this.measure()
      .then((figures) => {
        this.figures = figures;
      })
      .catch((error: unknown) => {
        this.options.logger.error(`Measuring the disk failed: ${String(error)}`);
      })
      .finally(() => {
        this.measuring = undefined;
      });
  }

  private async measure(): Promise<WorkerDisk> {
    const { dataDir } = this.options;
    const seen = new Set<string>();
    const runsDir = runsDirectory(dataDir);
    const workingCopiesBytes = await treeBytes(runsDir, seen);
    const cachesBytes = await treeBytes(cachesDirectory(dataDir), seen);
    const space = await (this.options.space ?? fileSystemSpace)(dataDir);
    return {
      workingCopiesBytes,
      cachesBytes,
      keptRuns: await countRuns(runsDir),
      freeBytes: Math.min(space.freeBytes, Number.MAX_SAFE_INTEGER),
      totalBytes: Math.min(space.totalBytes, Number.MAX_SAFE_INTEGER),
      minFreeBytes: this.options.minFreeBytes,
    };
  }
}

/** How many Run directories the worker holds. */
async function countRuns(runsDir: string): Promise<number> {
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && isUuid(entry.name)).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/**
 * Bytes of data under `root`, links not followed. A file with several hard links (a clone made
 * with `--local` links the cache's objects) counts once across everything measured with the
 * same `seen` set. A file that vanishes while it is measured (a Run being removed) counts 0.
 */
async function treeBytes(root: string, seen: Set<string>): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isGone(error)) continue;
      throw error;
    }
    for (const name of names) {
      const path = posix.join(dir, name);
      let stats: BigIntStats;
      try {
        stats = await lstat(path, { bigint: true });
      } catch (error) {
        if (isGone(error)) continue;
        throw error;
      }
      if (stats.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.nlink > 1n) {
        const key = `${stats.dev}:${stats.ino}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      total += Number(stats.size);
    }
  }
  return total;
}

function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
