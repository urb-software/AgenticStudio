import { spawn } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Why a Git process was killed before it finished. */
export type InterruptReason = 'timeout' | 'size_limit' | 'aborted';

/** The process was killed (with its whole process tree) before it finished. */
export class GitProcessInterrupted extends Error {
  constructor(readonly reason: InterruptReason) {
    super(`Git process interrupted: ${reason}`);
    this.name = 'GitProcessInterrupted';
  }
}

export interface SizeWatch {
  /** Directory whose disk usage is polled while the process runs. */
  path: string;
  maxBytes: number;
  intervalMs: number;
}

export interface RunOptions {
  binary: string;
  args: readonly string[];
  cwd: string;
  /** The complete environment: nothing is inherited from the API process. */
  env: Record<string, string>;
  /** Absolute time (ms since the epoch) at which the process is killed. */
  deadline: number;
  signal?: AbortSignal;
  watch?: SizeWatch;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Kept per stream; Git's useful messages are at the end. */
const MAX_STREAM_BYTES = 256 * 1024;

function appendCapped(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > MAX_STREAM_BYTES ? next.slice(next.length - MAX_STREAM_BYTES) : next;
}

/**
 * Runs Git without a shell, from an argument array, in its own process group. A timeout,
 * an abort or the size watch kills the whole group (Git and its `ssh`, `git-remote-https`,
 * `index-pack` children) and rejects with {@link GitProcessInterrupted}.
 */
export function runGitProcess(options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new GitProcessInterrupted('aborted'));
      return;
    }
    const child = spawn(options.binary, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let interrupted: InterruptReason | null = null;
    let spawnError: Error | null = null;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });

    const killTree = (reason: InterruptReason) => {
      if (interrupted) return;
      interrupted = reason;
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    };

    const timer = setTimeout(() => killTree('timeout'), Math.max(0, options.deadline - Date.now()));
    const onAbort = () => killTree('aborted');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let watcher: NodeJS.Timeout | undefined;
    if (options.watch) {
      const { path, maxBytes, intervalMs } = options.watch;
      let measuring = false;
      watcher = setInterval(() => {
        if (measuring || interrupted) return;
        measuring = true;
        void diskUsage(path)
          .then((bytes) => {
            if (bytes > maxBytes) killTree('size_limit');
          })
          .finally(() => {
            measuring = false;
          });
      }, intervalMs);
    }

    const settle = () => {
      clearTimeout(timer);
      clearInterval(watcher);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (error) => {
      spawnError = error;
      // The binary could not be started: there will be no process to wait for.
      if (child.pid === undefined) {
        settle();
        reject(error);
      }
    });
    child.on('close', (exitCode) => {
      settle();
      if (child.pid === undefined) return;
      if (interrupted) {
        reject(new GitProcessInterrupted(interrupted));
      } else if (spawnError) {
        reject(spawnError);
      } else {
        resolve({ exitCode, stdout, stderr });
      }
    });
  });
}

/** Bytes used by the files under `path`; symlinks are counted, never followed. */
export async function diskUsage(path: string): Promise<number> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return 0;
  }
  if (!stats.isDirectory()) return stats.size;
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return stats.size;
  }
  let total = stats.size;
  for (const entry of entries) {
    total += await diskUsage(join(path, entry));
  }
  return total;
}
