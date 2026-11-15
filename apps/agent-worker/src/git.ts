import { runProcess } from './process-runner.js';

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
export type GitTransport = (typeof WORKER_GIT_TRANSPORTS)[number];

/**
 * Transports for talking to a Project's remote in production: never `file` (a local path is
 * not a Repository; coordinator decision on #98). Local commands (the Working copy's clone of
 * the cache) use `file`.
 */
export const REMOTE_GIT_TRANSPORTS: readonly GitTransport[] = ['https', 'ssh'];

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
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'filter.lfs.smudge=',
  'filter.lfs.process=',
  'filter.lfs.required=false',
  'gc.auto=0',
  'maintenance.auto=false',
  'i18n.logOutputEncoding=UTF-8',
  // A redirect could lead an https fetch to another host, and packfile URIs (protocol v2)
  // let a server point Git elsewhere (security.md §4; review of #117, P1).
  'http.followRedirects=false',
  'fetch.uriProtocols=',
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
  /** The transports this command may use (default: all of {@link WORKER_GIT_TRANSPORTS}). */
  transports?: readonly GitTransport[];
  /**
   * Settings for this one command, passed through the environment (`GIT_CONFIG_COUNT`,
   * `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`): never on the command line, where other users
   * of the host could read them, and never in a config file (Issue #102: the Agent account's
   * push header).
   */
  config?: readonly (readonly [key: string, value: string])[];
  /**
   * `false`: the agent user's own global Git configuration is not read either
   * (`GIT_CONFIG_GLOBAL=/dev/null`), so nothing the agent could have written there (a URL
   * rewrite, a proxy, a credential helper) applies. For the token-carrying HTTPS push (#102).
   */
  userConfig?: false;
}

export interface GitRunnerOptions {
  /** The environment Git starts from (default: the worker's). `GIT_*` variables are dropped. */
  env?: Record<string, string | undefined>;
  /** The Git binary (default: `git` on the PATH). */
  binary?: string;
}

/** One command's settings as `GIT_CONFIG_*` environment variables (none: no variable at all). */
function configEnvironment(config: readonly (readonly [string, string])[]): Record<string, string> {
  if (config.length === 0) return {};
  return Object.fromEntries([
    ['GIT_CONFIG_COUNT', String(config.length)],
    ...config.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ]);
}

/** `scheme://user:secret@host` → `scheme://***@host`, so a log never shows a credential. */
export function maskCredentials(text: string): string {
  // Up to the last `@` before the host: a password may itself contain `@`.
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi, '$1***@');
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
  async run(args: readonly string[], options: GitOptions): Promise<string> {
    const command = args[0] ?? '';
    const transports = options.transports ?? WORKER_GIT_TRANSPORTS;
    const protocols = [
      'protocol.allow=never',
      ...transports.map((transport) => `protocol.${transport}.allow=always`),
    ].flatMap((setting) => ['-c', setting]);
    const result = await runProcess({
      binary: this.binary,
      args: [...GIT_HARDENING, ...protocols, ...args],
      cwd: options.cwd,
      env: {
        ...this.baseEnv,
        LC_ALL: 'C.UTF-8',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ALLOW_PROTOCOL: transports.join(':'),
        GIT_LFS_SKIP_SMUDGE: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        SSH_ASKPASS_REQUIRE: 'never',
        ...(options.ceiling ? { GIT_CEILING_DIRECTORIES: options.ceiling } : {}),
        ...(options.userConfig === false ? { GIT_CONFIG_GLOBAL: '/dev/null' } : {}),
        ...configEnvironment(options.config ?? []),
      },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    const stderr = maskCredentials(result.stderr);
    switch (result.interrupted) {
      case 'timeout':
      case 'aborted':
        throw new GitCommandError(command, null, stderr, result.interrupted);
      case 'missing':
      case 'spawn':
        throw new GitCommandError(command, null, '', 'spawn');
      case null:
        if (result.exitCode !== 0) {
          throw new GitCommandError(command, result.exitCode, stderr, 'exit');
        }
        return result.stdout;
    }
  }
}
