import { runProcess } from './process-runner.js';

/**
 * Git for the agent worker: the system `git` from an argument array (no shell, own process group,
 * time limit). Repository content is untrusted: no hooks, no submodules, no driver it names runs.
 * Git gets an allowlisted environment, and a Working copy command no global configuration.
 */

/** Transports a worker's Git command may use (`protocol.allow`, `GIT_ALLOW_PROTOCOL`). */
export const WORKER_GIT_TRANSPORTS = ['file', 'https', 'ssh'] as const;
export type GitTransport = (typeof WORKER_GIT_TRANSPORTS)[number];

/**
 * Transports for a Project's remote in production: never `file` (a local path is not a
 * Repository); local commands (the Working copy's clone of the cache) use `file`.
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
  // let a server point Git elsewhere.
  'http.followRedirects=false',
  'fetch.uriProtocols=',
].flatMap((setting) => ['-c', setting]);

/**
 * Further settings for a command in the Working copy (its own `.git/config`, an included file or
 * an attributes file may name programs). Given on the command line, which beats every
 * configuration file.
 */
export const WORKING_COPY_HARDENING: readonly (readonly [key: string, value: string])[] = [
  ['diff.external', ''],
  ['core.pager', 'cat'],
  ['core.editor', 'true'],
  ['sequence.editor', 'true'],
  ['gpg.program', 'false'],
  ['gpg.openpgp.program', 'false'],
  ['gpg.x509.program', 'false'],
  ['gpg.ssh.program', 'false'],
  ['core.sshCommand', 'false'],
  ['credential.helper', ''],
  ['core.askPass', ''],
  ['core.attributesFile', '/dev/null'],
  ['uploadpack.packObjectsHook', ''],
];

/** Flags of every `git diff` the worker runs: no external diff program, no textconv filter. */
export const SAFE_DIFF_FLAGS: readonly string[] = ['--no-ext-diff', '--no-textconv'];

/** Subcommands that can run a filter, merge, diff or textconv driver of the Working copy. */
const DRIVER_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'add',
  'checkout',
  'merge',
  'commit',
  'diff',
  'status',
  'reset',
  'read-tree',
  'write-tree',
  'stash',
  'cherry-pick',
  'rebase',
]);

/** Subcommands that can call an external diff program or a textconv filter. */
const DIFF_SUBCOMMANDS: ReadonlySet<string> = new Set(['diff', 'log', 'show']);

/** The variables of the worker's own environment that every Git command keeps. */
const BASE_ENVIRONMENT = ['PATH', 'HOME', 'TMPDIR'] as const;

/** What a command that reaches a remote also keeps: the agent user's SSH agent and proxies. */
const REMOTE_ENVIRONMENT = [
  'SSH_AUTH_SOCK',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

/**
 * The environment a Git command starts from: the allowlisted names of `source`, plus the network
 * profile for a remote command. Git needs none of Studio's tokens (the push gets its header
 * through `GIT_CONFIG_*`).
 */
export function gitBaseEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  scope: GitScope,
): Record<string, string> {
  const names: readonly string[] =
    scope === 'remote' ? [...BASE_ENVIRONMENT, ...REMOTE_ENVIRONMENT] : BASE_ENVIRONMENT;
  const environment: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/**
 * Overrides for the drivers the effective configuration names (`keys`: its key names, from
 * `git config --list --name-only`): no clean, smudge or process filter, no external diff or
 * textconv program, and `mergeDriver` in place of every merge driver's command.
 */
export function driverOverrides(
  keys: readonly string[],
  mergeDriver: string,
): [key: string, value: string][] {
  const overrides = new Map<string, string>();
  for (const key of keys) {
    const first = key.indexOf('.');
    const last = key.lastIndexOf('.');
    if (first < 0 || last <= first) continue;
    const section = key.slice(0, first).toLowerCase();
    const name = key.slice(first + 1, last);
    const variable = key.slice(last + 1).toLowerCase();
    if (section === 'filter') {
      for (const setting of ['clean', 'smudge', 'process']) {
        overrides.set(`filter.${name}.${setting}`, '');
      }
      overrides.set(`filter.${name}.required`, 'false');
    } else if (section === 'diff' && (variable === 'command' || variable === 'textconv')) {
      overrides.set(`diff.${name}.command`, '');
      overrides.set(`diff.${name}.textconv`, '');
    } else if (section === 'merge' && variable === 'driver') {
      overrides.set(`merge.${name}.driver`, mergeDriver);
    }
  }
  return [...overrides];
}

/**
 * The command that stands in for a repository-named merge driver: Git's own text merge
 * (`git merge-file`), so the merge goes on without the program the repository named.
 */
export function builtInMergeDriver(binary: string): string {
  const quoted = `'${binary.replaceAll("'", `'\\''`)}'`;
  return `${quoted} merge-file --marker-size=%L -L %X -L %S -L %Y %A %O %B`;
}

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

/**
 * What a command works on. `working-copy` (default): untrusted content, no global configuration,
 * no driver runs. `cache`: a local command in the bare cache. `remote`: reaches a remote (cache
 * `clone`/`fetch`, the push); also keeps `SSH_AUTH_SOCK` and the proxy variables.
 */
export type GitScope = 'working-copy' | 'cache' | 'remote';

export interface GitOptions {
  cwd: string;
  /** See {@link GitScope}. */
  scope?: GitScope;
  timeoutMs: number;
  signal?: AbortSignal;
  /** `GIT_CEILING_DIRECTORIES`: Git never looks for a repository above these. */
  ceiling?: string;
  /** The transports this command may use (default: all of {@link WORKER_GIT_TRANSPORTS}). */
  transports?: readonly GitTransport[];
  /**
   * Settings for this one command, through the environment (`GIT_CONFIG_COUNT`, ...): never on the
   * command line, where other users of the host could read them, nor in a config file. They come
   * from the caller, so no driver override applies to them.
   */
  config?: readonly (readonly [key: string, value: string])[];
  /**
   * `false`: the agent user's global Git configuration is not read either (`GIT_CONFIG_GLOBAL`), so
   * nothing the agent wrote there (URL rewrite, proxy, credential helper) applies to the push.
   * Always the case for a `working-copy` command.
   */
  userConfig?: false;
  /** `GIT_INDEX_FILE`: a temporary index for this one command, never the real one. */
  indexFile?: string;
  /** Most standard output kept (default: the process runner's 4 MiB); the rest is dropped. */
  maxStdout?: number;
}

export interface GitRunnerOptions {
  /** The environment Git starts from (default: the worker's); only allowlisted names are kept. */
  env?: Record<string, string | undefined>;
  binary?: string;
}

/** The Git subcommand of an argument array: its first argument that is not an option. */
function subcommandOf(args: readonly string[]): string {
  return args.find((arg) => !arg.startsWith('-')) ?? '';
}

/**
 * A Working copy command that shows a diff (`diff`, `log`, `show`) never calls an external diff
 * program nor a textconv filter, whatever its caller passed.
 */
function withSafeDiff(args: readonly string[], scope: GitScope): readonly string[] {
  if (scope !== 'working-copy') return args;
  const index = args.findIndex((arg) => !arg.startsWith('-'));
  if (index < 0 || !DIFF_SUBCOMMANDS.has(args[index]!)) return args;
  return [...args.slice(0, index + 1), ...SAFE_DIFF_FLAGS, ...args.slice(index + 1)];
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
  private readonly source: Record<string, string | undefined>;
  private readonly binary: string;

  constructor(options: GitRunnerOptions = {}) {
    // Cut down per command ({@link gitBaseEnvironment}): neither the worker's tokens nor an
    // inherited GIT_DIR, GIT_WORK_TREE or GIT_CONFIG_PARAMETERS reaches Git.
    this.source = options.env ?? process.env;
    this.binary = options.binary ?? 'git';
  }

  /** Runs `git <hardening> <args>`: standard output, or rejects with {@link GitCommandError}. */
  async run(args: readonly string[], options: GitOptions): Promise<string> {
    const scope = options.scope ?? 'working-copy';
    // The Working copy's configuration is read once per command that can run a driver, and the
    // drivers it names are neutralised for that command. A failure to list stops the command.
    const drivers =
      scope === 'working-copy' && DRIVER_SUBCOMMANDS.has(subcommandOf(args))
        ? await this.driverSettings(options)
        : [];
    return this.execute(withSafeDiff(args, scope), options, scope, [
      ...drivers,
      ...(options.config ?? []),
    ]);
  }

  /** Overrides for the drivers the Working copy's effective configuration names (runs none). */
  private async driverSettings(options: GitOptions) {
    const listing = await this.execute(
      ['config', '--list', '--name-only', '-z'],
      {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        ceiling: options.ceiling,
      },
      'working-copy',
      [],
    );
    return driverOverrides(
      listing.split('\0').filter((key) => key !== ''),
      builtInMergeDriver(this.binary),
    );
  }

  private async execute(
    args: readonly string[],
    options: GitOptions,
    scope: GitScope,
    config: readonly (readonly [string, string])[],
  ): Promise<string> {
    const command = args[0] ?? '';
    const transports = options.transports ?? WORKER_GIT_TRANSPORTS;
    const protocols = [
      'protocol.allow=never',
      ...transports.map((transport) => `protocol.${transport}.allow=always`),
    ].flatMap((setting) => ['-c', setting]);
    const workingCopy =
      scope === 'working-copy'
        ? WORKING_COPY_HARDENING.flatMap(([key, value]) => ['-c', `${key}=${value}`])
        : [];
    const result = await runProcess({
      binary: this.binary,
      args: [...GIT_HARDENING, ...workingCopy, ...protocols, ...args],
      cwd: options.cwd,
      env: {
        ...gitBaseEnvironment(this.source, scope),
        LC_ALL: 'C.UTF-8',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ALLOW_PROTOCOL: transports.join(':'),
        GIT_LFS_SKIP_SMUDGE: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_PAGER: 'cat',
        GIT_EDITOR: 'true',
        GIT_SEQUENCE_EDITOR: 'true',
        GIT_ASKPASS: '',
        SSH_ASKPASS_REQUIRE: 'never',
        ...(options.ceiling ? { GIT_CEILING_DIRECTORIES: options.ceiling } : {}),
        ...(options.userConfig === false || scope === 'working-copy'
          ? { GIT_CONFIG_GLOBAL: '/dev/null' }
          : {}),
        ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
        ...configEnvironment(config),
      },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      ...(options.maxStdout === undefined ? {} : { maxStdout: options.maxStdout }),
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
