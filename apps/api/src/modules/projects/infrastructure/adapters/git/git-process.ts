import { spawn } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type InterruptReason = 'timeout' | 'size_limit' | 'aborted';

export class GitProcessInterrupted extends Error {
  constructor(readonly reason: InterruptReason) {
    super(`Git process interrupted: ${reason}`);
    this.name = 'GitProcessInterrupted';
  }
}

export interface SizeWatch {
  path: string;
  maxBytes: number;
  intervalMs: number;
}

/**
 * A hard memory bound for the process and every child it starts: the process runs as
 * `prlimit --as=<bytes> -- <binary> …` (util-linux). `RLIMIT_AS` is inherited across fork and
 * exec, and an unprivileged process may lower its own limit, so no capability is needed.
 */
export interface MemoryBound {
  /** Address space, in bytes, of each process in the group. */
  bytes: number;
  prlimitBinary: string;
}

export interface RunOptions {
  binary: string;
  args: readonly string[];
  cwd: string;
  /** The complete environment: nothing is inherited from the API process. */
  env: Record<string, string>;
  deadline: number;
  signal?: AbortSignal;
  watch?: SizeWatch;
  memoryBound?: MemoryBound;
  /**
   * Keeps the first bytes of stdout instead of the last, and ends the process once more than
   * this many arrive (`stdoutCut` is then true). For output whose start matters, such as a patch.
   */
  stdoutLimitBytes?: number;
  /**
   * How stdout is decoded (default `utf8`). `latin1` maps every byte to one character, so
   * `Buffer.from(stdout, 'latin1')` returns the exact bytes of a binary blob.
   */
  stdoutEncoding?: 'utf8' | 'latin1';
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutCut: boolean;
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
    const bound = options.memoryBound;
    const file = bound ? bound.prlimitBinary : options.binary;
    const args = bound
      ? [`--as=${bound.bytes}`, '--', options.binary, ...options.args]
      : options.args;
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stdoutCut = false;
    let interrupted: InterruptReason | null = null;
    let spawnError: Error | null = null;
    const stdoutLimit = options.stdoutLimitBytes;
    const encoding = options.stdoutEncoding ?? 'utf8';
    child.stdout.setEncoding(encoding).on('data', (chunk: string) => {
      if (stdoutLimit === undefined) {
        stdout = appendCapped(stdout, chunk);
        return;
      }
      if (stdoutCut) return;
      stdoutBytes += Buffer.byteLength(chunk, encoding);
      stdout += chunk;
      if (stdoutBytes > stdoutLimit) {
        stdoutCut = true;
        endGroup();
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });

    const endGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    };
    const killTree = (reason: InterruptReason) => {
      if (interrupted) return;
      interrupted = reason;
      endGroup();
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
        resolve({ exitCode, stdout, stderr, stdoutCut });
      }
    });
  });
}

/** Bytes used by the files under `path`; symlinks are counted, never followed (hostile repository). */
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
