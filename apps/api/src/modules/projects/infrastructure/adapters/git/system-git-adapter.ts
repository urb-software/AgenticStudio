import { Logger, type OnModuleInit } from '@nestjs/common';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type AppConfig, SHELL_SAFE_PATH } from '../../../../../platform/config/config.js';
import { parseSshHostKey } from '../../../../../platform/config/ssh-known-hosts.js';
import {
  GitCloneMissingError,
  type GitOperationOptions,
  GitOperationError,
  GitRequestRejectedError,
  GitUnsupportedPlatformError,
  type RemoteInspection,
  type RepositoryGit,
  type SshCredentials,
} from '../../../ports/repository-git.js';
import { ClonePaths } from './clone-paths.js';
import { classifyGitFailure, redactGitOutput } from './git-output.js';
import { diskUsage, GitProcessInterrupted, runGitProcess, type SizeWatch } from './git-process.js';
import { checkedAddresses, type ResolveHost, systemResolveHost } from './remote-host.js';
import {
  parseRemoteUrl,
  remoteEndpoint,
  type GitTransport,
  type RemoteUrl,
  type RemoteEndpoint,
} from './remote-url.js';

/**
 * The lowest Git that supports every mechanism the adapter relies on:
 * `http.curloptResolve` (2.37; pins HTTPS to the checked address, Issue #69),
 * `GIT_CONFIG_GLOBAL` (2.32; with `GIT_CONFIG_NOSYSTEM` it isolates the host's Git
 * configuration), `--no-write-fetch-head` (2.29), `protocol.allow` / `GIT_ALLOW_PROTOCOL`,
 * `http.followRedirects`, `core.hooksPath`, `ls-remote --symref` and `init --template=` (all
 * older).
 */
export const MIN_GIT_VERSION = '2.37.0';

/** Production limits (security.md §4). The adapter takes them as inputs; tests pass smaller ones. */
export const PRODUCTION_GIT_LIMITS = {
  cloneTimeoutMs: 10 * 60 * 1000,
  fetchTimeoutMs: 2 * 60 * 1000,
  maxCloneBytes: 2 * 1024 ** 3,
} as const;

/** Production transports: exactly `ssh` and `https` (security.md §4). */
export const PRODUCTION_TRANSPORTS: readonly GitTransport[] = ['ssh', 'https'];

export interface SystemGitSettings {
  /** Absolute data directory; Clones live in `<dataDir>/clones/`. */
  dataDir: string;
  allowedTransports: readonly GitTransport[];
  /** Limit for a clone. */
  cloneTimeoutMs: number;
  /** Limit for a fetch, and for the other operations. */
  fetchTimeoutMs: number;
  /** Largest disk usage of a Clone, in bytes. */
  maxCloneBytes: number;
  /** How often a running clone or fetch measures the Clone's disk usage. Default 1 s. */
  sizePollIntervalMs?: number;
  /** Default `process.platform`; anything but `linux` is unsupported. */
  platform?: NodeJS.Platform;
  /** Default `git` from `PATH`. */
  gitBinary?: string;
  /** Default `ssh` from `PATH`. */
  sshBinary?: string;
  /** Default `ssh-keyscan` from `PATH` (part of the OpenSSH client). */
  keyscanBinary?: string;
  /**
   * Where per-operation private directories (`studio-git-*`: SSH key, known hosts) go.
   * Default `<dataDir>/tmp`, created owner-only; never inside a Clone.
   */
  tempRoot?: string;
  /** Receives redacted Git output of failed operations. Default: the Nest logger. */
  log?: (message: string) => void;
  /** The user whose stale leftovers the start-up sweep may remove. Default `process.getuid()`. */
  uid?: number;
  /**
   * `STUDIO_GIT_ALLOW_PRIVATE_REMOTES` (Issue #69): whether remotes on loopback and private
   * addresses are allowed. Link-local, metadata, multicast and reserved addresses never are.
   */
  allowPrivateRemotes: boolean;
  /** Default: the system resolver. Tests inject one. */
  resolveHost?: ResolveHost;
  /**
   * Test-only: a CA certificate file Git trusts for HTTPS, for local TLS fixture servers.
   * The production wiring never sets it.
   */
  httpsCaFile?: string;
}

/**
 * The production wiring: limits and transports pinned, file remotes only under the test-only
 * setting, loopback and private remotes only under `STUDIO_GIT_ALLOW_PRIVATE_REMOTES`.
 */
export function systemGitSettings(config: AppConfig): SystemGitSettings {
  return {
    dataDir: config.dataDir,
    allowedTransports: config.gitAllowFileRemotes
      ? [...PRODUCTION_TRANSPORTS, 'file']
      : PRODUCTION_TRANSPORTS,
    ...PRODUCTION_GIT_LIMITS,
    allowPrivateRemotes: config.gitAllowPrivateRemotes,
  };
}

/**
 * Hardening applied to every Git command (security.md §4): hooks never run, credential
 * helpers and fsmonitor are off, only the allowed transports work, submodules are never
 * recursed into, LFS never smudges, no background maintenance outlives the command, and an
 * HTTP redirect is never followed (it could lead past the address check, Issue #69).
 */
function hardeningArgs(transports: readonly GitTransport[]): string[] {
  return [
    'core.hooksPath=/dev/null',
    'core.fsmonitor=false',
    'credential.helper=',
    'protocol.allow=never',
    ...transports.map((transport) => `protocol.${transport}.allow=always`),
    'submodule.recurse=false',
    'fetch.recurseSubmodules=false',
    'filter.lfs.smudge=',
    'filter.lfs.process=',
    'filter.lfs.required=false',
    'gc.auto=0',
    'maintenance.auto=false',
    'fetch.writeCommitGraph=false',
    'http.followRedirects=false',
  ].flatMap((setting) => ['-c', setting]);
}

/**
 * A remote whose host was checked against the address policy (Issue #69): Git and ssh
 * connect only to `addresses`, never to what a second lookup might return.
 */
interface CheckedRemote extends RemoteUrl {
  /** `null` for a `file` remote. */
  endpoint: RemoteEndpoint | null;
  /** The allowed addresses of the host, in resolver order; empty for a `file` remote. */
  addresses: string[];
}

/**
 * The one checked address ssh and ssh-keyscan connect to (`HostName` takes one): the first
 * IPv4 address, else the first. IPv4 first, because unlike ssh itself the pinned connection
 * cannot fall back to the next address when IPv6 is not reachable.
 */
function sshAddress(addresses: string[]): string {
  return addresses.find((address) => !address.includes(':')) ?? addresses[0]!;
}

/** `-c` settings that pin an https remote's host to its checked addresses (curl's resolve list). */
function pinArgs(remote: CheckedRemote): string[] {
  if (remote.transport !== 'https' || !remote.endpoint) return [];
  const { host, port } = remote.endpoint;
  // An IP-literal host is never looked up; pinning it would change nothing.
  if (remote.addresses.length === 1 && remote.addresses[0] === host) return [];
  const addresses = remote.addresses.map((address) =>
    address.includes(':') ? `[${address}]` : address,
  );
  return ['-c', `http.curloptResolve=${host}:${port}:${addresses.join(',')}`];
}

/** Alias the supplied host key is pinned to, whatever host or port the URL names. */
const HOST_KEY_ALIAS = 'studio-remote';
const PRIVATE_KEY =
  /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\n[\s\S]+\n-----END [A-Z0-9 ]*PRIVATE KEY-----\n?$/;
const GIT_VERSION = /^git version (\d+)\.(\d+)\.(\d+)/;
/** Host key types `scanHostKey` asks for, and its preference among them (first wins). */
const SCANNED_KEY_TYPES = 'ed25519,ecdsa,rsa';
const SCAN_PREFERENCE = [/^ssh-ed25519$/, /^ecdsa-sha2-/, /^ssh-rsa$/];
/** Longest ssh-keyscan connection timeout, in seconds. */
const MAX_SCAN_TIMEOUT_S = 30;
/** Prefix of per-operation private directories. */
const OPERATION_DIR_PREFIX = 'studio-git-';
/** A leftover is stale once it is older than the clone limit plus this margin. */
const STALE_MARGIN_MS = 5 * 60 * 1000;
/** Git lock files at the top of a Clone that a killed process may leave behind. */
const TOP_LEVEL_LOCK = /\.lock$/;

function isValidBranchName(branch: string): boolean {
  return (
    branch.length > 0 &&
    branch.length <= 255 &&
    branch !== '@' &&
    !branch.startsWith('-') &&
    !branch.startsWith('/') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.') &&
    !branch.includes('..') &&
    !branch.includes('//') &&
    !branch.includes('@{') &&
    // eslint-disable-next-line no-control-regex -- control characters are not allowed in refs
    !/[\u0000- \u007f~^:?*[\\]/.test(branch) &&
    branch.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
  );
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function abortError(): Error {
  const error = new Error('The Git operation was aborted.');
  error.name = 'AbortError';
  return error;
}

interface OperationContext {
  /** Private, owner-only directory: working directory and HOME of every command. */
  dir: string;
  env: Record<string, string>;
  deadline: number;
  signal?: AbortSignal;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * The `projects` Git adapter: runs the system `git` binary under the fixed hardening
 * baseline of security.md §4. Linux only.
 *
 * Operations on one project are serialized by an in-process lock (one API process). Any
 * failure other than the port's typed errors and `AbortError` becomes
 * `GitOperationError('unknown')`; the raw error goes, redacted, to the server log only.
 *
 * Residual risk: if the API process itself dies, the detached Git process group of a
 * running operation is orphaned and keeps running without Studio's time and size limits
 * until Git finishes or fails on its own. The start-up sweep then removes stale
 * per-operation directories (with any SSH key) and partial Clones.
 */
export class SystemGitAdapter implements RepositoryGit, OnModuleInit {
  private readonly paths: ClonePaths;
  private readonly platform: NodeJS.Platform;
  private readonly gitBinary: string;
  private readonly sshBinary: string;
  private readonly keyscanBinary: string;
  private readonly resolveHost: ResolveHost;
  private readonly tempRoot: string;
  private readonly sizePollIntervalMs: number;
  private readonly log: (message: string) => void;
  /** Per-project tail of the operation queue: operations on one Clone never overlap. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Whether per-operation directories live in the default `<dataDir>/tmp`, owned by this process. */
  private readonly ownsTempRoot: boolean;

  constructor(private readonly settings: SystemGitSettings) {
    this.paths = new ClonePaths(settings.dataDir);
    this.platform = settings.platform ?? process.platform;
    this.gitBinary = settings.gitBinary ?? 'git';
    this.sshBinary = settings.sshBinary ?? 'ssh';
    this.keyscanBinary = settings.keyscanBinary ?? 'ssh-keyscan';
    this.resolveHost = settings.resolveHost ?? systemResolveHost;
    this.tempRoot = settings.tempRoot ?? join(settings.dataDir, 'tmp');
    this.ownsTempRoot = settings.tempRoot === undefined;
    this.sizePollIntervalMs = settings.sizePollIntervalMs ?? 1000;
    const logger = new Logger('Git');
    this.log = settings.log ?? ((message) => logger.warn(message));
  }

  /**
   * Start-up on Linux: `git` must be installed at {@link MIN_GIT_VERSION} or later, and
   * leftovers of operations a crash interrupted are removed.
   */
  async onModuleInit(): Promise<void> {
    if (this.platform !== 'linux') return;
    await this.verifyGitVersion();
    await this.sweepStaleLeftovers();
  }

  /**
   * Removes leftovers of operations a crash interrupted, before any operation runs: every
   * partial Clone, and the per-operation directories (which may hold a Deploy key) owned by
   * this user. One API process owns the data directory, so nothing in it is live at
   * start-up; only a custom temp root, which may be shared, keeps directories younger than
   * the clone limit plus a margin. A failing entry is logged (redacted) and skipped.
   */
  private async sweepStaleLeftovers(): Promise<void> {
    const staleBefore = Date.now() - this.settings.cloneTimeoutMs - STALE_MARGIN_MS;
    const uid = this.settings.uid ?? process.getuid?.();
    const sweep = async (dir: string, matches: (name: string) => boolean, anyAge: boolean) => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const name of names.filter(matches)) {
        try {
          const path = join(dir, name);
          const stats = await lstat(path);
          if (stats.isDirectory() && stats.uid === uid && (anyAge || stats.mtimeMs < staleBefore)) {
            await rm(path, { recursive: true, force: true });
          }
        } catch (error) {
          this.log(`start-up sweep skipped an entry: ${redactGitOutput(String(error))}`);
        }
      }
    };
    try {
      await sweep(
        this.tempRoot,
        (name) => name.startsWith(OPERATION_DIR_PREFIX),
        this.ownsTempRoot,
      );
      if (await this.paths.verifyClonesFolder()) {
        await sweep(this.paths.clonesFolder, (name) => /\.git\.partial-[\da-f]+$/.test(name), true);
      }
    } catch (error) {
      this.log(`start-up sweep failed: ${redactGitOutput(String(error))}`);
    }
  }

  async verifyGitVersion(): Promise<string> {
    let output: string;
    try {
      const result = await this.withOperation(this.settings.fetchTimeoutMs, {}, (context) =>
        this.git(context, ['--version']),
      );
      output = result.stdout.trim();
    } catch (error) {
      throw new Error(
        `Repository features need git ${MIN_GIT_VERSION} or later, but git could not be run (${
          (error as Error).name
        }). Install git and an SSH client, or check PATH.`,
      );
    }
    const match = GIT_VERSION.exec(output);
    const version = match ? match.slice(1, 4).map(Number) : null;
    if (!version || compareVersions(version, MIN_GIT_VERSION.split('.').map(Number)) < 0) {
      throw new Error(
        `Repository features need git ${MIN_GIT_VERSION} or later; found "${output.slice(0, 80)}".`,
      );
    }
    return version.join('.');
  }

  assertSupported(): void {
    this.assertSupportedPlatform();
  }

  async inspectRemote(
    remoteUrl: string,
    branch: string,
    options: GitOperationOptions = {},
  ): Promise<RemoteInspection> {
    this.assertSupportedPlatform();
    const remote = this.parseRemote(remoteUrl, options);
    this.assertBranch(branch);
    const { stdout } = await this.guarded('ls-remote', () =>
      this.withOperation(this.settings.fetchTimeoutMs, options, async (context) =>
        this.gitOrFail(
          context,
          ['ls-remote', '--symref', remote.url, 'HEAD', `refs/heads/${branch}`],
          await this.checkRemote(context, remote),
          options.ssh,
        ),
      ),
    );
    let defaultBranch: string | null = null;
    let branchExists = false;
    for (const line of stdout.split('\n')) {
      const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
      if (symref) defaultBranch = symref[1] ?? null;
      if (/^[\da-f]{40,64}\t/.test(line) && line.endsWith(`\trefs/heads/${branch}`)) {
        branchExists = true;
      }
    }
    return { defaultBranch, branchExists };
  }

  async scanHostKey(
    remoteUrl: string,
    options: GitOperationOptions = {},
  ): Promise<{ hostKey: string }> {
    this.assertSupportedPlatform();
    const remote = parseRemoteUrl(remoteUrl, this.settings.allowedTransports);
    if (remote.transport !== 'ssh') {
      throw new GitRequestRejectedError('Only an ssh remote has a host key to retrieve.');
    }
    return this.guarded('ssh-keyscan', () =>
      this.withOperation(this.settings.fetchTimeoutMs, options, async (context) => {
        const { endpoint, addresses } = await this.checkRemote(context, remote);
        const seconds = Math.min(
          MAX_SCAN_TIMEOUT_S,
          Math.max(1, Math.ceil((context.deadline - Date.now()) / 1000)),
        );
        const result = await this.run(context, this.keyscanBinary, [
          '-T',
          String(seconds),
          '-p',
          String(endpoint!.port),
          '-t',
          SCANNED_KEY_TYPES,
          '--',
          // The checked address, never the name: ssh-keyscan would look it up again.
          sshAddress(addresses),
        ]);
        const keys = result.stdout
          .split('\n')
          .filter((line) => line.trim() !== '' && !line.startsWith('#'))
          .map((line) => parseSshHostKey(line.trim().split(/\s+/).slice(1, 3).join(' ')))
          .filter((key): key is string => key !== null);
        for (const preferred of SCAN_PREFERENCE) {
          const key = keys.find((candidate) => preferred.test(candidate.split(' ')[0]!));
          if (key) return { hostKey: key };
        }
        const detail = redactGitOutput(result.stderr);
        const reason = classifyGitFailure(result.stderr);
        this.log(`ssh-keyscan found no host key: ${detail}`);
        throw new GitOperationError(
          reason === 'unknown' || reason === 'auth_failed' ? 'host_unreachable' : reason,
          detail,
        );
      }),
    );
  }

  async clone(
    projectId: string,
    remoteUrl: string,
    branch: string,
    options: GitOperationOptions = {},
  ): Promise<{ commit: string }> {
    this.assertSupportedPlatform();
    const target = this.paths.clone(projectId);
    const remote = this.parseRemote(remoteUrl, options);
    this.assertBranch(branch);
    return this.guarded('clone', () =>
      this.queued(projectId, this.settings.cloneTimeoutMs, options, async (options) => {
        if (await this.paths.existingClone(projectId)) {
          throw new GitRequestRejectedError('The project already has a Clone.');
        }
        await this.paths.ensureClonesFolder();
        const partial = this.paths.partial(projectId);
        try {
          return await this.withOperation(
            this.settings.cloneTimeoutMs,
            options,
            async (context) => {
              const checked = await this.checkRemote(context, remote);
              await this.gitOrFail(context, ['init', '--bare', '--quiet', '--template=', partial]);
              await this.gitOrFail(context, [
                `--git-dir=${partial}`,
                'symbolic-ref',
                'HEAD',
                `refs/heads/${branch}`,
              ]);
              await this.fetchInto(context, partial, checked, branch, options.ssh);
              const commit = await this.revParse(context, partial, branch);
              await rename(partial, target);
              return { commit };
            },
          );
        } finally {
          await rm(partial, { recursive: true, force: true });
        }
      }),
    );
  }

  async fetch(
    projectId: string,
    remoteUrl: string,
    branch: string,
    options: GitOperationOptions = {},
  ): Promise<{ commit: string }> {
    this.assertSupportedPlatform();
    this.paths.clone(projectId);
    const remote = this.parseRemote(remoteUrl, options);
    this.assertBranch(branch);
    return this.guarded('fetch', () =>
      this.queued(projectId, this.settings.fetchTimeoutMs, options, async (options) => {
        const clone = await this.paths.existingClone(projectId);
        if (!clone) {
          throw new GitCloneMissingError();
        }
        // Under the lock no other Git process works on this Clone: any lock file is stale.
        await removeStaleLocks(clone);
        try {
          return await this.withOperation(
            this.settings.fetchTimeoutMs,
            options,
            async (context) => {
              const checked = await this.checkRemote(context, remote);
              await this.fetchInto(context, clone, checked, branch, options.ssh);
              return { commit: await this.revParse(context, clone, branch) };
            },
          );
        } catch (error) {
          if (error instanceof GitOperationError && error.reason === 'size_limit') {
            // Killed mid-transfer or finished past the limit: no usable Clone remains (#61).
            await rm(clone, { recursive: true, force: true });
          } else {
            // A killed fetch leaves Git's temporary packs; the refs are unchanged.
            await removeTemporaryObjects(clone);
          }
          throw error;
        }
      }),
    );
  }

  async readBranchCommit(
    projectId: string,
    branch: string,
    options: GitOperationOptions = {},
  ): Promise<{ commit: string }> {
    this.assertSupportedPlatform();
    this.assertBranch(branch);
    this.paths.clone(projectId);
    return this.guarded('rev-parse', () =>
      this.queued(projectId, this.settings.fetchTimeoutMs, options, async (options) => {
        const clone = await this.paths.existingClone(projectId);
        if (!clone) {
          throw new GitCloneMissingError();
        }
        return this.withOperation(this.settings.fetchTimeoutMs, options, async (context) => ({
          commit: await this.revParse(context, clone, branch),
        }));
      }),
    );
  }

  async removeClone(projectId: string, options: GitOperationOptions = {}): Promise<void> {
    this.assertSupportedPlatform();
    const target = this.paths.clone(projectId);
    if (options.signal?.aborted) throw abortError();
    await this.guarded('remove', () =>
      this.exclusive(projectId, async () => {
        if (!(await this.paths.verifyClonesFolder())) return;
        const partials = (await readdir(this.paths.clonesFolder)).filter((name) =>
          this.paths.isPartialOf(projectId, name),
        );
        // rm never follows symlinks: a symlink in place of the Clone is removed, not its target.
        await Promise.all(
          [target, ...partials.map((name) => join(this.paths.clonesFolder, name))].map((path) =>
            rm(path, { recursive: true, force: true }),
          ),
        );
      }),
    );
  }

  /**
   * {@link exclusive} with the time limit applied from the moment of the call: time spent
   * waiting for the project lock counts, and `work` gets only what is left of it.
   */
  private queued<T>(
    projectId: string,
    limitMs: number,
    options: GitOperationOptions,
    work: (options: GitOperationOptions) => Promise<T>,
  ): Promise<T> {
    const budgetMs = Math.min(limitMs, options.timeoutMs ?? limitMs);
    const queuedAt = Date.now();
    return this.exclusive(projectId, async () => {
      if (options.signal?.aborted) throw abortError();
      const remainingMs = budgetMs - (Date.now() - queuedAt);
      if (remainingMs <= 0) throw new GitOperationError('timeout');
      return work({ ...options, timeoutMs: remainingMs });
    });
  }

  /** Runs `work` after every earlier operation on the project has settled. */
  private async exclusive<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    const current = previous.then(work, work);
    const tail = current.catch(() => undefined);
    this.locks.set(projectId, tail);
    try {
      return await current;
    } finally {
      if (this.locks.get(projectId) === tail) this.locks.delete(projectId);
    }
  }

  /**
   * The port's typed errors and `AbortError` pass through; anything else (a file-system
   * error, a bug) becomes `GitOperationError('unknown')` whose detail is at most an errno
   * code. The raw error is logged, redacted.
   */
  private async guarded<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof GitOperationError ||
        error instanceof GitRequestRejectedError ||
        error instanceof GitUnsupportedPlatformError ||
        isAbortError(error)
      ) {
        throw error;
      }
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      const detail = typeof code === 'string' && /^E[A-Z0-9]+$/.test(code) ? code : '';
      const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.log(`${operation} failed (unknown): ${redactGitOutput(raw)}`);
      throw new GitOperationError('unknown', detail);
    }
  }

  private assertSupportedPlatform(): void {
    if (this.platform !== 'linux') {
      throw new GitUnsupportedPlatformError(this.platform);
    }
  }

  private assertBranch(branch: string): void {
    if (!isValidBranchName(branch)) {
      throw new GitRequestRejectedError('The branch name is not a valid Git branch name.');
    }
  }

  private parseRemote(remoteUrl: string, options: GitOperationOptions): RemoteUrl {
    const remote = parseRemoteUrl(remoteUrl, this.settings.allowedTransports);
    if (remote.transport === 'ssh') {
      if (!options.ssh) {
        throw new GitRequestRejectedError('An ssh remote needs a Deploy key and a host key.');
      }
      if (!PRIVATE_KEY.test(options.ssh.privateKey.replace(/\r\n/g, '\n'))) {
        throw new GitRequestRejectedError('The Deploy key is not a PEM-armoured private key.');
      }
      const { hostKeys } = options.ssh;
      // The same accepted types and checks as STUDIO_SSH_KNOWN_HOSTS (ssh-known-hosts.ts).
      if (hostKeys.length === 0 || !hostKeys.every((key) => parseSshHostKey(key) !== null)) {
        throw new GitRequestRejectedError(
          'The host keys are missing or not valid OpenSSH public keys.',
        );
      }
    }
    return remote;
  }

  /**
   * Checks the remote's host against the address policy before any process reaches it
   * (Issue #69): its addresses are resolved once, under the operation's deadline and abort
   * signal, and every one must be allowed. Git and ssh are then pinned to them.
   */
  private async checkRemote(context: OperationContext, remote: RemoteUrl): Promise<CheckedRemote> {
    const endpoint = remoteEndpoint(remote);
    if (!endpoint) return { ...remote, endpoint, addresses: [] };
    const addresses = await checkedAddresses(
      endpoint.host,
      this.settings.allowPrivateRemotes,
      (host) => this.withinDeadline(context, this.resolveHost(host)),
    );
    return { ...remote, endpoint, addresses };
  }

  /** `work`, unless the operation's deadline passes (`timeout`) or it is aborted first. */
  private async withinDeadline<T>(context: OperationContext, work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new GitOperationError('timeout')),
        Math.max(0, context.deadline - Date.now()),
      );
      onAbort = () => reject(abortError());
      if (context.signal?.aborted) onAbort();
      context.signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([work, interrupted]);
    } finally {
      clearTimeout(timer);
      if (onAbort) context.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Runs `work` with a private temporary directory and a fresh environment, under one
   * deadline (the caller's limit if shorter than the adapter's). The directory, and with
   * it any SSH key, is deleted afterwards, also on failure, timeout or abort.
   */
  private async withOperation<T>(
    limitMs: number,
    options: GitOperationOptions,
    work: (context: OperationContext) => Promise<T>,
  ): Promise<T> {
    if (options.signal?.aborted) throw abortError();
    const timeoutMs = Math.min(limitMs, options.timeoutMs ?? limitMs);
    const deadline = Date.now() + timeoutMs;
    await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(this.tempRoot, OPERATION_DIR_PREFIX));
    try {
      const context: OperationContext = {
        dir,
        env: this.environment(dir),
        deadline,
        signal: options.signal,
      };
      return await work(context);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * The complete environment of a Git command; nothing is inherited but `PATH`. Host Git
   * configuration, credential helpers, askpass programs and SSH agents are unreachable.
   */
  private environment(dir: string): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: dir,
      LC_ALL: 'C',
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CEILING_DIRECTORIES: dirname(dir),
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: this.settings.allowedTransports.join(':'),
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      SSH_ASKPASS_REQUIRE: 'never',
    };
  }

  /**
   * Writes the Deploy key (owner-only) and the trusted host keys into the operation's
   * private directory and returns the environment that makes Git's `ssh` use exactly
   * them: no agent, no other identity, no user or system SSH configuration, strict
   * host-key checking, and a connection to the checked `address` only (`HostName`; host-key
   * trust stays with the alias).
   */
  private async sshEnvironment(
    context: OperationContext,
    credentials: SshCredentials,
    address: string,
  ): Promise<Record<string, string>> {
    const keyFile = join(context.dir, 'deploy_key');
    const knownHosts = join(context.dir, 'known_hosts');
    const embedded =
      this.sshBinary === 'ssh' ? [keyFile, knownHosts] : [keyFile, knownHosts, this.sshBinary];
    for (const path of embedded) {
      if (!SHELL_SAFE_PATH.test(path)) {
        throw new GitRequestRejectedError('The temporary directory path is not shell-safe.');
      }
    }
    const privateKey = credentials.privateKey.replace(/\r\n/g, '\n');
    await writeFile(keyFile, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    const lines = credentials.hostKeys.map(
      (hostKey) => `${HOST_KEY_ALIAS} ${parseSshHostKey(hostKey)}\n`,
    );
    await writeFile(knownHosts, lines.join(''), { mode: 0o600, flag: 'wx' });
    const sshOptions = [
      // An IP address (digits, hex, `.` and `:`): safe on the shell command line.
      `HostName=${address}`,
      'BatchMode=yes',
      'StrictHostKeyChecking=yes',
      `UserKnownHostsFile='${knownHosts}'`,
      'GlobalKnownHostsFile=/dev/null',
      `HostKeyAlias=${HOST_KEY_ALIAS}`,
      'CheckHostIP=no',
      'UpdateHostKeys=no',
      'IdentitiesOnly=yes',
      'IdentityAgent=none',
      `IdentityFile='${keyFile}'`,
      'PubkeyAuthentication=yes',
      'PreferredAuthentications=publickey',
      'PasswordAuthentication=no',
      'KbdInteractiveAuthentication=no',
      'ForwardAgent=no',
      'ForwardX11=no',
      'ClearAllForwardings=yes',
      'PermitLocalCommand=no',
      'ControlMaster=no',
      'ControlPath=none',
      'ProxyCommand=none',
      'ConnectTimeout=30',
    ];
    const ssh = this.sshBinary === 'ssh' ? 'ssh' : `'${this.sshBinary}'`;
    return {
      GIT_SSH_COMMAND: [ssh, '-F', '/dev/null', ...sshOptions.flatMap((o) => ['-o', o])].join(' '),
      GIT_SSH_VARIANT: 'ssh',
    };
  }

  private async fetchInto(
    context: OperationContext,
    gitDir: string,
    remote: CheckedRemote,
    branch: string,
    ssh: SshCredentials | undefined,
  ): Promise<void> {
    const watch: SizeWatch = {
      path: gitDir,
      maxBytes: this.settings.maxCloneBytes,
      intervalMs: this.sizePollIntervalMs,
    };
    await this.gitOrFail(
      context,
      [
        `--git-dir=${gitDir}`,
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-recurse-submodules',
        '--',
        remote.url,
        `+refs/heads/${branch}:refs/heads/${branch}`,
      ],
      remote,
      ssh,
      watch,
    );
    if ((await diskUsage(gitDir)) > this.settings.maxCloneBytes) {
      throw new GitOperationError('size_limit');
    }
  }

  private async revParse(
    context: OperationContext,
    gitDir: string,
    branch: string,
  ): Promise<string> {
    const result = await this.git(context, [
      `--git-dir=${gitDir}`,
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}^{commit}`,
    ]);
    const commit = result.stdout.trim();
    if (result.exitCode !== 0 || !/^[\da-f]{40,64}$/.test(commit)) {
      throw new GitOperationError('branch_not_found');
    }
    return commit;
  }

  /**
   * Runs a Git command, connecting to a `remote` only at its checked addresses; fails with a
   * fixed reason and redacted detail on a non-zero exit.
   */
  private async gitOrFail(
    context: OperationContext,
    args: string[],
    remote?: CheckedRemote,
    ssh?: SshCredentials,
    watch?: SizeWatch,
  ): Promise<{ stdout: string }> {
    const env =
      remote?.transport === 'ssh' && ssh
        ? {
            ...context.env,
            ...(await this.sshEnvironment(context, ssh, sshAddress(remote.addresses))),
          }
        : context.env;
    const config = remote ? pinArgs(remote) : [];
    const result = await this.git({ ...context, env }, [...config, ...args], watch);
    if (result.exitCode !== 0) {
      const detail = redactGitOutput(result.stderr);
      const reason = classifyGitFailure(result.stderr);
      this.log(`git ${args.find((arg) => !arg.startsWith('-'))} failed (${reason}): ${detail}`);
      throw new GitOperationError(reason, detail);
    }
    return result;
  }

  private git(context: OperationContext, args: string[], watch?: SizeWatch) {
    const caFile = this.settings.httpsCaFile
      ? ['-c', `http.sslCAInfo=${this.settings.httpsCaFile}`]
      : [];
    return this.run(
      context,
      this.gitBinary,
      [...hardeningArgs(this.settings.allowedTransports), ...caFile, ...args],
      watch,
    );
  }

  /** Runs a binary in the operation's directory and environment, under its deadline. */
  private async run(context: OperationContext, binary: string, args: string[], watch?: SizeWatch) {
    try {
      return await runGitProcess({
        binary,
        args,
        cwd: context.dir,
        env: context.env,
        deadline: context.deadline,
        signal: context.signal,
        watch,
      });
    } catch (error) {
      if (error instanceof GitProcessInterrupted) {
        if (error.reason === 'aborted') throw abortError();
        throw new GitOperationError(error.reason);
      }
      throw error;
    }
  }
}

/**
 * Lock files a killed Git process left in a Clone (`HEAD.lock`, `packed-refs.lock`,
 * `shallow.lock`, lock files under `refs/`); they would make every later fetch fail. Symlinks are
 * never followed.
 */
async function removeStaleLocks(gitDir: string): Promise<void> {
  const removeIn = async (dir: string, recursive: boolean): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isFile() && TOP_LEVEL_LOCK.test(entry.name)) {
        await rm(path, { force: true });
      } else if (recursive && entry.isDirectory()) {
        await removeIn(path, true);
      }
    }
  };
  await removeIn(gitDir, false);
  await removeIn(join(gitDir, 'refs'), true);
}

/** Git's temporary files left by a killed fetch (packs being received). */
async function removeTemporaryObjects(gitDir: string): Promise<void> {
  const packDir = join(gitDir, 'objects', 'pack');
  let names: string[];
  try {
    names = await readdir(packDir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith('tmp_'))
      .map((name) => rm(join(packDir, name), { force: true })),
  );
}
