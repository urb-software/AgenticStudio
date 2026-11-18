import { spawn } from 'node:child_process';

/**
 * The one place the worker's own helper processes (`git`, `docker` for a Run's containers) are
 * started, never a provider CLI. Every process gets an argument array, no shell, no standard
 * input, its own process group and a time limit; a timeout or an abort kills the whole group.
 */

export interface ProcessOptions {
  /** The program, e.g. `git`; looked up on the PATH of `env`. */
  binary: string;
  args: readonly string[];
  cwd?: string;
  /** The complete environment of the process. */
  env: Record<string, string | undefined>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Most standard output kept. */
  maxStdout?: number;
}

export interface ProcessResult {
  /** The exit code; `null` when the process was killed or could not start. */
  exitCode: number | null;
  stdout: string;
  /** The last few KiB of standard error. */
  stderr: string;
  /** Why it did not run to its end, if it did not. */
  interrupted: 'timeout' | 'aborted' | 'missing' | 'spawn' | null;
}

const MAX_STDERR = 8 * 1024;
const DEFAULT_MAX_STDOUT = 4 * 1024 * 1024;

/** Runs a helper process to its end; never rejects (the result says what happened). */
export function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ exitCode: null, stdout: '', stderr: '', interrupted: 'aborted' });
      return;
    }
    const maxStdout = options.maxStdout ?? DEFAULT_MAX_STDOUT;
    const child = spawn(options.binary, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let interrupted: ProcessResult['interrupted'] = null;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < maxStdout) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR);
    });
    const kill = (reason: 'timeout' | 'aborted') => {
      if (interrupted) return;
      interrupted = reason;
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    };
    const timer = setTimeout(() => kill('timeout'), options.timeoutMs);
    const onAbort = () => kill('aborted');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let settled = false;
    const settle = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    child.once('error', (error: NodeJS.ErrnoException) =>
      settle({
        exitCode: null,
        stdout,
        stderr,
        interrupted: error.code === 'ENOENT' ? 'missing' : 'spawn',
      }),
    );
    child.once('close', (code) =>
      settle({ exitCode: interrupted ? null : code, stdout, stderr, interrupted }),
    );
  });
}
