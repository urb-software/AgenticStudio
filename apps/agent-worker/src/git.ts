import { spawn } from 'node:child_process';

/**
 * Git for the agent worker (Issue #98). Every call runs the system `git` from an argument
 * array, without a shell, in its own process group, with prompts disabled and a time limit;
 * a timeout or an abort kills the whole group. Repository content is untrusted: hooks never
 * run, submodules are never recursed into, LFS never smudges, and only the `file`, `https`
 * and `ssh` transports work (no `ext::` or `fd::` helpers).
 *
 * Unlike Studio's hardened Git adapter (which serves Studio's own Clones), the worker keeps
 * the agent user's own Git configuration: that is where the agent side's Git credentials
 * live (the server set-up, #107). The worker writes no credential anywhere.
 */

/** Transports a worker's Git command may use (`protocol.allow`, `GIT_ALLOW_PROTOCOL`). */
export const WORKER_GIT_TRANSPORTS = ['file', 'https', 'ssh'] as const;

/** Time limits of the worker's Git commands. */
export const GIT_TIMEOUTS = {
  /** Talking to the remote: cloning or fetching the cache. */
  network: 15 * 60_000,
  /** Everything local: the Working copy clone, checkout, log, status. */
  local: 2 * 60_000,
} as const;

/** `-c` settings applied to every Git command the worker runs. */
export const GIT_HARDENING: readonly string[] = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'protocol.allow=never',
  ...WORKER_GIT_TRANSPORTS.map((transport) => `protocol.${transport}.allow=always`),
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'filter.lfs.smudge=',
  'filter.lfs.process=',
  'filter.lfs.required=false',
  'gc.auto=0',
  'maintenance.auto=false',
  'i18n.logOutputEncoding=UTF-8',
].flatMap((setting) => ['-c', setting]);

/** A Git command failed: it exited non-zero, timed out, was aborted, or could not start. */
export class GitCommandError extends Error {
  constructor(
    /** The Git subcommand (e.g. `fetch`); never its arguments. */
    readonly command: string,
    readonly exitCode: number | null,
    /** The end of Git's error output, with credentials in URLs masked. For the log only. */
    readonly stderr: string,
    readonly reason: 'exit' | 'timeout' | 'aborted' | 'spawn',
  ) {
    super(
      reason === 'exit'
        ? `git ${command} exited with code ${exitCode}`
        : `git ${command} ${reason === 'spawn' ? 'could not be started' : reason === 'timeout' ? 'timed out' : 'was aborted'}`,
    );
    this.name = 'GitCommandError';
  }
}

export interface GitOptions {
  /** Working directory of the command. */
  cwd: string;
  /** Time limit in milliseconds. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** `GIT_CEILING_DIRECTORIES`: Git never looks for a repository above these. */
  ceiling?: string;
}

export interface GitRunnerOptions {
  /** The environment Git starts from (default: the worker's). `GIT_*` variables are dropped. */
  env?: Record<string, string | undefined>;
  /** The Git binary (default: `git` on the PATH). */
  binary?: string;
}

/** Kept of Git's error output; its useful messages are at the end. */
const MAX_STDERR = 8 * 1024;
/** Most standard output kept (a capped `git log` stays far below it). */
const MAX_STDOUT = 4 * 1024 * 1024;

/** `scheme://user:secret@host` → `scheme://***@host`, so a log never shows a credential. */
export function maskCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@');
}

/**
 * Runs the worker's Git commands. One instance per worker; tests give it their own
 * environment (e.g. a `HOME` with a hostile Git configuration).
 */
export class GitRunner {
  private readonly baseEnv: Record<string, string>;
  private readonly binary: string;

  constructor(options: GitRunnerOptions = {}) {
    const source = options.env ?? process.env;
    // Inherited GIT_* variables (GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_PARAMETERS, ...) could point
    // a command at another repository or change its configuration: none is passed on.
    this.baseEnv = Object.fromEntries(
      Object.entries(source).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !entry[0].toUpperCase().startsWith('GIT_'),
      ),
    );
    this.binary = options.binary ?? 'git';
  }

  /** Runs `git <hardening> <args>`; resolves with its standard output, rejects with {@link GitCommandError}. */
  run(args: readonly string[], options: GitOptions): Promise<string> {
    const command = args[0] ?? '';
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new GitCommandError(command, null, '', 'aborted'));
        return;
      }
      const child = spawn(this.binary, [...GIT_HARDENING, ...args], {
        cwd: options.cwd,
        env: {
          ...this.baseEnv,
          LC_ALL: 'C.UTF-8',
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_ALLOW_PROTOCOL: WORKER_GIT_TRANSPORTS.join(':'),
          GIT_LFS_SKIP_SMUDGE: '1',
          GIT_NO_REPLACE_OBJECTS: '1',
          SSH_ASKPASS_REQUIRE: 'never',
          ...(options.ceiling ? { GIT_CEILING_DIRECTORIES: options.ceiling } : {}),
        },
        shell: false,
        // Its own process group (and session: no terminal to prompt on); killed as a whole.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let interrupted: 'timeout' | 'aborted' | null = null;
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        if (stdout.length < MAX_STDOUT) stdout += chunk;
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
      const settle = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      child.once('error', () => {
        settle();
        reject(new GitCommandError(command, null, '', 'spawn'));
      });
      child.once('close', (code) => {
        settle();
        if (interrupted) {
          reject(new GitCommandError(command, null, maskCredentials(stderr), interrupted));
        } else if (code !== 0) {
          reject(new GitCommandError(command, code, maskCredentials(stderr), 'exit'));
        } else {
          resolve(stdout);
        }
      });
    });
  }
}
