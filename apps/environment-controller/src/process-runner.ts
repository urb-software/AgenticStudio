import { spawn } from 'node:child_process';

/**
 * The one place the controller starts a process: a literal program name from a fixed list, an
 * argument array, no shell, no standard input, its own process group. A timeout or abort sends
 * SIGTERM to the group, then SIGKILL. `socat` runs only as the argument of `nsenter`.
 */
export type ProcessBinary = 'docker' | 'systemctl' | 'egress-rules' | 'nsenter';

export type BinaryPaths = Record<ProcessBinary, string>;

export const DEFAULT_BINARIES: BinaryPaths = {
  docker: 'docker',
  systemctl: 'systemctl',
  'egress-rules': '/usr/local/lib/agentic-studio/preview-egress-rules',
  nsenter: 'nsenter',
};

export interface ProcessOptions {
  binary: ProcessBinary;
  args: readonly string[];
  cwd?: string;
  /** The complete environment of the process: nothing else is inherited. */
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Time between SIGTERM and SIGKILL. */
  graceMs?: number;
  /** Called with each complete output line, as it arrives. */
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
  /** Most standard output kept in the result (default 4 MiB). */
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

export interface RunningProcess {
  readonly pid: number | undefined;
  /** Settles when the process has ended. */
  readonly exited: Promise<ProcessResult>;
  /** SIGTERM to the group, SIGKILL after the grace period; resolves once it has ended. */
  stop(): Promise<void>;
}

export interface ProcessRunner {
  run(options: ProcessOptions): Promise<ProcessResult>;
  /** Starts a process that is meant to keep running (the socket bridge). */
  start(options: Omit<ProcessOptions, 'timeoutMs'>): RunningProcess;
}

const MAX_STDERR = 8 * 1024;
const DEFAULT_MAX_STDOUT = 4 * 1024 * 1024;
const DEFAULT_GRACE_MS = 10_000;

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process is already gone.
    }
  }
}

/** Splits a stream into lines; the last partial line is delivered by `flush`. */
function lineSplitter(emit: (line: string) => void) {
  let rest = '';
  return {
    push(chunk: string) {
      rest += chunk;
      let index = rest.indexOf('\n');
      while (index !== -1) {
        emit(rest.slice(0, index).replace(/\r$/, ''));
        rest = rest.slice(index + 1);
        index = rest.indexOf('\n');
      }
      // A line without a newline is not held without bound.
      if (rest.length > 64 * 1024) {
        emit(rest);
        rest = '';
      }
    },
    flush() {
      if (rest !== '') emit(rest);
      rest = '';
    },
  };
}

export class NodeProcessRunner implements ProcessRunner {
  constructor(private readonly binaries: BinaryPaths = DEFAULT_BINARIES) {}

  run(options: ProcessOptions): Promise<ProcessResult> {
    if (options.signal?.aborted) {
      return Promise.resolve({ exitCode: null, stdout: '', stderr: '', interrupted: 'aborted' });
    }
    const running = this.spawnProcess(options, options.timeoutMs);
    return running.exited;
  }

  start(options: Omit<ProcessOptions, 'timeoutMs'>): RunningProcess {
    return this.spawnProcess(options, undefined);
  }

  private spawnProcess(
    options: Omit<ProcessOptions, 'timeoutMs'>,
    timeoutMs: number | undefined,
  ): RunningProcess {
    const maxStdout = options.maxStdout ?? DEFAULT_MAX_STDOUT;
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    const child = spawn(this.binaries[options.binary], [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let interrupted: ProcessResult['interrupted'] = null;
    let ended = false;
    const outLines = lineSplitter((line) => options.onLine?.('stdout', line));
    const errLines = lineSplitter((line) => options.onLine?.('stderr', line));
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < maxStdout) stdout += chunk;
      outLines.push(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR);
      errLines.push(chunk);
    });

    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (reason: 'timeout' | 'aborted' | null) => {
      if (interrupted === null && reason !== null) interrupted = reason;
      if (ended || killTimer) return;
      signalGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), graceMs);
    };
    const timer =
      timeoutMs === undefined ? undefined : setTimeout(() => terminate('timeout'), timeoutMs);
    const onAbort = () => terminate('aborted');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const exited = new Promise<ProcessResult>((resolve) => {
      let settled = false;
      const settle = (result: ProcessResult) => {
        if (settled) return;
        settled = true;
        ended = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', onAbort);
        if (interrupted) signalGroup(child.pid, 'SIGKILL');
        outLines.flush();
        errLines.flush();
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
    return {
      pid: child.pid,
      exited,
      async stop() {
        terminate(null);
        await exited;
      },
    };
  }
}
