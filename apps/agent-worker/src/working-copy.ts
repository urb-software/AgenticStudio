import {
  COMMIT_SUBJECT_MAX_LENGTH,
  type EnvironmentFile,
  environmentFilePathProblem,
  jsonByteLength,
  type RunPayload,
  WORKING_COPY_COMMITS_MAX,
  WORKING_COPY_REPORT_MAX_BYTES,
  type WorkingCopyReport,
} from '@agentic-studio/contracts';
import { appendFile, lstat, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { LowFreeSpaceError } from './disk.js';
import {
  GIT_TIMEOUTS,
  GitCommandError,
  type GitRunner,
  type GitTransport,
  REMOTE_GIT_TRANSPORTS,
  WORKER_GIT_TRANSPORTS,
} from './git.js';
import {
  assertRealDirectory,
  cacheDirectory,
  cachesDirectory,
  composeProjectName,
  runBranchName,
  runDirectories,
  runsDirectory,
} from './run-layout.js';

/** A Run's prepared Working copy: where it is, its Run branch, and its Run steps' environment. */
export interface PreparedRun {
  runId: string;
  /** The Run's own directory: the Working copy and, beside it, the Task and the Run file. */
  runDir: string;
  /** The Working copy, on the Run branch at the start commit. */
  repoDir: string;
  runBranch: string;
  startCommit: string;
  /**
   * Where the Run's own changes are counted from in diffs and commit lists: the integration commit
   * the Run branch last merged (as the pull request counts), else the start commit.
   */
  diffBase?: string;
  /** Variables every Run step of this Run gets, e.g. `COMPOSE_PROJECT_NAME`. */
  env: Record<string, string>;
}

/** Where the Run's own changes are counted from (see {@link PreparedRun.diffBase}). */
export function diffBaseOf(prepared: Pick<PreparedRun, 'startCommit' | 'diffBase'>): string {
  return prepared.diffBase ?? prepared.startCommit;
}

/** What the worker records in `run.json` beside the Working copy; retention reads it. */
export interface RunFile {
  runId: string;
  projectId: string;
  runBranch: string;
  startCommit: string;
  composeProjectName: string;
  /**
   * Paths (relative to the Working copy) of files Studio places in it, e.g. the Environment file:
   * never committed or pushed. Absent in a Run file written before this field existed.
   */
  studioPaths?: string[];
}

/** The Working copy port of the worker loop: {@link WorkingCopies} in production. */
export interface WorkingCopyPort {
  /** Prepares the Run's Working copy; throws {@link PreparationFailedError} with a clear detail. */
  prepare(run: RunPayload, signal: AbortSignal): Promise<PreparedRun>;
  /** The Working copy's state after a Run step, for the step report. */
  report(prepared: PreparedRun, signal: AbortSignal): Promise<WorkingCopyReport>;
  /**
   * For a resume: the Run's kept Working copy, unchanged since its question, on the Run branch
   * Studio recorded. Throws {@link PreparationFailedError} when it is gone. With
   * `replaceEnvironmentFile` the Studio-placed files are replaced by the claim's new snapshot.
   */
  locate(run: RunPayload, signal?: AbortSignal): Promise<PreparedRun>;
}

/** Why a resume cannot go on: its Working copy was removed. */
export const RESUME_NO_WORKING_COPY =
  'Working copy no longer exists — run again: retention or a clean-up removed it.';

/** The Working copy could not be prepared; `detail` is safe to show (no credential, no path). */
export class PreparationFailedError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'PreparationFailedError';
  }
}

/** Where the worker writes what it does; never a token. */
export interface WorkingCopyLogger {
  error(message: string): void;
}

export interface WorkingCopiesOptions {
  /** Absolute directory of the caches and the Runs' directories. */
  dataDir: string;
  git: GitRunner;
  /** The Agent account's Git identity, set in each Working copy. */
  agentGitName: string;
  agentGitEmail: string;
  /**
   * Whether a Project's remote may be a local path (`file://`, the fixture remotes of tests):
   * only a development or test worker (`STUDIO_WORKER_ENVIRONMENT`) allows it.
   */
  allowFileRemotes: boolean;
  logger: WorkingCopyLogger;
  /**
   * Checked before a new Run's Working copy is made; throws {@link LowFreeSpaceError} when the
   * disk is short. A resume and a delivery use the Working copy they have: not checked.
   */
  freeSpace?: { assertEnoughFreeSpace(): Promise<void> };
}

/** An https or SSH remote (URL or scp-like `user@host:path`); anything else is local. */
const NETWORK_REMOTE = /^(?:https:\/\/|ssh:\/\/|git\+ssh:\/\/|ssh\+git:\/\/|[^@/:\s]+@[^@/:\s]+:)/i;

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The section Studio keeps in a Working copy's `.git/info/exclude`: files Studio places in the
 * Working copy later (e.g. the Environment file) are listed under it, so they are never
 * committed or pushed.
 */
export const STUDIO_EXCLUDE_SECTION =
  '\n# AI Agent Studio: files Studio places in this Working copy; never committed.\n';

/**
 * Prepares and inspects Working copies: a cache per Project, cloned per Run, no credential kept.
 * The preparation steps: docs/architecture/agent-worker.md.
 */
export class WorkingCopies implements WorkingCopyPort {
  constructor(private readonly options: WorkingCopiesOptions) {}

  async prepare(run: RunPayload, signal: AbortSignal): Promise<PreparedRun> {
    const { dataDir, git } = this.options;
    // Throws UnsafeIdentifierError before anything is touched: the payload is validated
    // already, and this is the path-safety guard of its own.
    const paths = runDirectories(dataDir, run.runId);
    const cacheDir = cacheDirectory(dataDir, run.projectId);
    const runBranch = runBranchName(run.task, run.runId);
    const compose = composeProjectName(run.runId);
    const startCommit = run.startCommit.toLowerCase();
    if (!COMMIT_ID.test(startCommit)) {
      throw new PreparationFailedError('The start commit is not a full commit id.');
    }
    const remoteUrl = run.repository.remoteUrl;
    this.assertAllowedRemote(remoteUrl);
    // The payload is validated already; this is the worker's own guard before any write.
    const environmentFile = run.environmentFile;
    if (environmentFile && environmentFilePathProblem(environmentFile.path) !== null) {
      throw new PreparationFailedError('The Environment file path is not a safe relative path.');
    }

    try {
      await this.options.freeSpace?.assertEnoughFreeSpace();
    } catch (error) {
      if (error instanceof LowFreeSpaceError) throw new PreparationFailedError(error.detail);
      throw error;
    }

    await assertRealDirectory(cachesDirectory(dataDir), true);
    await assertRealDirectory(runsDirectory(dataDir), true);
    // A Run is claimed once; anything left under its id is stale.
    await rm(paths.runDir, { recursive: true, force: true });
    await mkdir(paths.runDir, { mode: 0o700 });
    const runFile: RunFile = {
      runId: run.runId,
      projectId: run.projectId,
      runBranch,
      startCommit,
      composeProjectName: compose,
      studioPaths: [...run.studioPaths],
    };
    await writeFile(paths.runFile, `${JSON.stringify(runFile, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(paths.taskFile, `${run.task}\n`, { flag: 'wx', mode: 0o600 });

    await this.refreshCache(cacheDir, remoteUrl, signal);
    await this.ensureCommit(cacheDir, startCommit, signal);
    await this.checkRefFormat(runBranch, paths.runDir, signal);

    const local = { timeoutMs: GIT_TIMEOUTS.local, signal, ceiling: dataDir };
    await this.step('making the Working copy', () =>
      git.run(['clone', '--local', '--no-checkout', '--quiet', '--', cacheDir, paths.repoDir], {
        ...local,
        cwd: paths.runDir,
      }),
    );
    const inRepo = { ...local, cwd: paths.repoDir };
    await this.step('checking out the start commit', () =>
      git.run(
        [
          'checkout',
          '--quiet',
          '--no-recurse-submodules',
          '-b',
          runBranch,
          `${startCommit}^{commit}`,
        ],
        inRepo,
      ),
    );
    const head = (await git.run(['rev-parse', 'HEAD'], inRepo)).trim();
    if (head !== startCommit) {
      throw new PreparationFailedError('The Working copy is not at the start commit.');
    }
    await git.run(['config', '--local', 'user.name', this.options.agentGitName], inRepo);
    await git.run(['config', '--local', 'user.email', this.options.agentGitEmail], inRepo);
    // A later push goes to the Project's Repository, with the agent side's own credentials.
    await git.run(['remote', 'set-url', 'origin', remoteUrl], inRepo);
    const exclude = posix.join(paths.repoDir, '.git', 'info', 'exclude');
    await mkdir(posix.dirname(exclude), { recursive: true });
    await appendFile(exclude, STUDIO_EXCLUDE_SECTION);
    if (environmentFile) {
      await this.placeEnvironmentFile(paths.repoDir, startCommit, environmentFile, signal);
      await appendFile(exclude, `${excludePattern(environmentFile.path)}\n`);
    }

    return {
      runId: run.runId,
      runDir: paths.runDir,
      repoDir: paths.repoDir,
      runBranch,
      startCommit,
      env: { COMPOSE_PROJECT_NAME: compose },
    };
  }

  async locate(run: RunPayload, signal?: AbortSignal): Promise<PreparedRun> {
    // The Run branch and start commit come from Studio, never from `run.json`, which the agent
    // could rewrite.
    if (run.kind !== 'resume' || run.runBranch === undefined) {
      throw new PreparationFailedError('Studio sent no recorded Run branch for this resume.');
    }
    const paths = runDirectories(this.options.dataDir, run.runId);
    const runFile = await readRunFile(paths.runFile);
    const repo = await stat(paths.repoDir).then(
      (stats) => stats.isDirectory(),
      () => false,
    );
    if (!runFile || runFile.runId !== run.runId || runFile.projectId !== run.projectId || !repo) {
      throw new PreparationFailedError(RESUME_NO_WORKING_COPY);
    }
    // The agent continues exactly where it stopped: on the Run branch Studio recorded.
    if (!(await onBranch(this.options.git, paths.repoDir, run.runBranch, this.options.dataDir))) {
      throw new PreparationFailedError(
        `The Working copy is not on its Run branch ${run.runBranch}, so the run cannot resume ` +
          'there — run again.',
      );
    }
    if (run.replaceEnvironmentFile) {
      await this.replaceEnvironmentFile(
        paths,
        run,
        signal ?? AbortSignal.timeout(GIT_TIMEOUTS.local),
      );
    }
    return {
      runId: run.runId,
      runDir: paths.runDir,
      repoDir: paths.repoDir,
      runBranch: run.runBranch,
      startCommit: run.startCommit.toLowerCase(),
      // The merge of this part, if it already started, is counted as merged too.
      diffBase: run.updateTip ?? run.mergedIntegrationCommit ?? run.startCommit.toLowerCase(),
      env: { COMPOSE_PROJECT_NAME: composeProjectName(run.runId) },
    };
  }

  async report(prepared: PreparedRun, signal: AbortSignal): Promise<WorkingCopyReport> {
    const git = this.options.git;
    const options = {
      cwd: prepared.repoDir,
      timeoutMs: GIT_TIMEOUTS.local,
      signal,
      ceiling: this.options.dataDir,
    };
    const branchRef = `refs/heads/${prepared.runBranch}`;
    let commits: WorkingCopyReport['commits'] = [];
    const exists = await git
      .run(['rev-parse', '--verify', '--quiet', `${branchRef}^{commit}`], options)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const log = await git.run(
        [
          'log',
          '--no-show-signature',
          '--format=%H%x00%s%x00',
          `--max-count=${WORKING_COPY_COMMITS_MAX}`,
          `${diffBaseOf(prepared)}..${branchRef}`,
          '--',
        ],
        options,
      );
      const fields = log.split('\0');
      const newestFirst: WorkingCopyReport['commits'] = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        newestFirst.push({ id: fields[i]!.trim(), subject: shorten(fields[i + 1]!) });
      }
      commits = newestFirst.reverse();
    }
    const status = await git.run(
      ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      options,
    );
    const report: WorkingCopyReport = {
      runBranch: prepared.runBranch,
      commits,
      hasUncommittedChanges: status.length > 0,
    };
    // Within the protocol's byte budget: the oldest commits give way first.
    while (jsonByteLength(report) > WORKING_COPY_REPORT_MAX_BYTES && report.commits.length > 0) {
      report.commits.shift();
    }
    return report;
  }

  /**
   * Writes the Run's Environment file into the Working copy, owner-only (0600). Refused when the
   * path is tracked (at the start commit or `runBranch`'s) or goes through a symlink or a non-
   * directory; the file is created new, never written through.
   */
  private async placeEnvironmentFile(
    repoDir: string,
    startCommit: string,
    file: EnvironmentFile,
    signal: AbortSignal,
    runBranch?: string,
  ): Promise<void> {
    const options = {
      cwd: repoDir,
      timeoutMs: GIT_TIMEOUTS.local,
      signal,
      ceiling: this.options.dataDir,
    };
    // `<commit>:<path>` names a tracked file or directory at that path, taken literally.
    const trackedAt = (revision: string) =>
      this.options.git
        .run(['rev-parse', '--verify', '--quiet', `${revision}:${file.path}`], options)
        .then(() => true)
        .catch((error: unknown) => {
          if (error instanceof GitCommandError && error.reason === 'exit') return false;
          throw error;
        });
    const tracked =
      (await trackedAt(startCommit)) ||
      (runBranch !== undefined && (await trackedAt(`refs/heads/${runBranch}`)));
    if (tracked) {
      throw new PreparationFailedError('Environment file path is tracked in the repository');
    }
    const segments = file.path.split('/');
    let current = repoDir;
    for (const segment of segments.slice(0, -1)) {
      current = posix.join(current, segment);
      const stats = await lstat(current).catch(() => null);
      if (!stats) {
        await mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
          throw new PreparationFailedError(
            `The Environment file's directory could not be made (${errorCode(error)}).`,
          );
        });
      } else if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new PreparationFailedError(
          'The Environment file path leads through a symlink or a file in the repository.',
        );
      }
    }
    const target = posix.join(current, segments.at(-1)!);
    // `wx`: created exclusively, so an existing file or symlink at the path is never followed.
    const handle = await open(target, 'wx', 0o600).catch((error: unknown) => {
      throw new PreparationFailedError(
        `The Environment file could not be written (${errorCode(error)}).`,
      );
    });
    try {
      await handle.chmod(0o600);
      await handle.writeFile(file.content, 'utf8');
    } finally {
      await handle.close();
    }
  }

  /**
   * A Follow-up works with the Project's current Environment file: every Studio-placed file is
   * removed (never through a symlink), then the claim's new file, if any, is written, so none is
   * committed.
   */
  private async replaceEnvironmentFile(
    paths: ReturnType<typeof runDirectories>,
    run: RunPayload,
    signal: AbortSignal,
  ): Promise<void> {
    const file = run.environmentFile;
    if (file && environmentFilePathProblem(file.path) !== null) {
      throw new PreparationFailedError('The Environment file path is not a safe relative path.');
    }
    for (const path of run.studioPaths) {
      if (environmentFilePathProblem(path) !== null) continue;
      await removeStudioFile(paths.repoDir, path);
    }
    if (!file) return;
    await this.placeEnvironmentFile(
      paths.repoDir,
      run.startCommit.toLowerCase(),
      file,
      signal,
      run.runBranch,
    );
    const exclude = posix.join(paths.repoDir, '.git', 'info', 'exclude');
    const listed = await readFile(exclude, 'utf8').catch(() => '');
    if (!listed.includes(STUDIO_EXCLUDE_SECTION.trim())) {
      await appendFile(exclude, STUDIO_EXCLUDE_SECTION);
    }
    await appendFile(exclude, `${excludePattern(file.path)}\n`);
    const runFile = await readRunFile(paths.runFile);
    if (runFile) {
      const studioPaths = [...new Set([...(runFile.studioPaths ?? []), ...run.studioPaths])];
      await writeFile(paths.runFile, `${JSON.stringify({ ...runFile, studioPaths }, null, 2)}\n`, {
        mode: 0o600,
      });
    }
  }

  /**
   * Brings the Project's cache up to date with its remote, the one place the worker fetches from
   * the network, and returns its path. Same remote rules as at a Run's start. Throws
   * {@link PreparationFailedError} with a clear detail.
   */
  async refreshProjectCache(run: RunPayload, signal: AbortSignal): Promise<string> {
    const remoteUrl = run.repository.remoteUrl;
    this.assertAllowedRemote(remoteUrl);
    const cacheDir = cacheDirectory(this.options.dataDir, run.projectId);
    await assertRealDirectory(cachesDirectory(this.options.dataDir), true);
    await this.refreshCache(cacheDir, remoteUrl, signal);
    return cacheDir;
  }

  /** The Project's remote must be a URL Git may be asked to reach, never an option or a path. */
  private assertAllowedRemote(remoteUrl: string): void {
    if (remoteUrl.startsWith('-')) {
      throw new PreparationFailedError("The Project's remote URL is not valid.");
    }
    if (!this.options.allowFileRemotes && !NETWORK_REMOTE.test(remoteUrl)) {
      throw new PreparationFailedError(
        "The Project's remote is a local path; only a development or test agent worker accepts one.",
      );
    }
  }

  /** Transports for talking to the Project's remote. */
  private get remoteTransports(): readonly GitTransport[] {
    return this.options.allowFileRemotes ? WORKER_GIT_TRANSPORTS : REMOTE_GIT_TRANSPORTS;
  }

  /**
   * Creates the cache, or refreshes it. It is discarded and rebuilt only when its remote
   * differs (or it has none, i.e. it is not a usable cache); a failed refresh keeps it, so a
   * passing network problem never throws a good cache away.
   */
  private async refreshCache(cacheDir: string, remoteUrl: string, signal: AbortSignal) {
    const { git, dataDir } = this.options;
    const network = {
      cwd: posix.dirname(cacheDir),
      scope: 'remote' as const,
      timeoutMs: GIT_TIMEOUTS.network,
      signal,
      ceiling: dataDir,
      transports: this.remoteTransports,
    };
    // A cache that does not exist yet has no remote (and Git is not run in a missing directory).
    const exists = await stat(cacheDir).then(
      (stats) => stats.isDirectory(),
      () => false,
    );
    const current = !exists
      ? null
      : await git
          .run(['config', '--get', 'remote.origin.url'], {
            ...network,
            scope: 'cache',
            cwd: cacheDir,
            timeoutMs: GIT_TIMEOUTS.local,
          })
          .then((url) => url.trim())
          .catch(() => null);
    if (current === remoteUrl) {
      await this.step("refreshing the Project's cache", () =>
        git.run(['fetch', '--prune', '--quiet', 'origin'], { ...network, cwd: cacheDir }),
      );
      return;
    }
    await rm(cacheDir, { recursive: true, force: true });
    await this.step("fetching the Project's repository", async () => {
      await git.run(['clone', '--bare', '--quiet', '--', remoteUrl, cacheDir], network);
      // Every branch of the remote, kept as is, also on later fetches.
      await git.run(['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'], {
        ...network,
        scope: 'cache',
        cwd: cacheDir,
      });
    });
  }

  /** The start commit must be in the cache; one direct fetch is tried for one no branch holds. */
  private async ensureCommit(cacheDir: string, commit: string, signal: AbortSignal) {
    const { git, dataDir } = this.options;
    const options = {
      cwd: cacheDir,
      scope: 'cache' as const,
      timeoutMs: GIT_TIMEOUTS.local,
      signal,
      ceiling: dataDir,
    };
    const present = () =>
      git
        .run(['cat-file', '-e', `${commit}^{commit}`], options)
        .then(() => true)
        .catch(() => false);
    if (await present()) return;
    await git
      .run(['fetch', '--quiet', 'origin', commit], {
        ...options,
        scope: 'remote',
        timeoutMs: GIT_TIMEOUTS.network,
        transports: this.remoteTransports,
      })
      .catch(() => undefined);
    signal.throwIfAborted();
    if (await present()) return;
    throw new PreparationFailedError(
      `The start commit ${commit} is not in the Project's repository; ` +
        'it may have been removed (e.g. by a force-push).',
    );
  }

  private async checkRefFormat(branch: string, cwd: string, signal: AbortSignal) {
    await this.options.git
      .run(['check-ref-format', '--branch', branch], { cwd, timeoutMs: GIT_TIMEOUTS.local, signal })
      .catch(() => {
        throw new PreparationFailedError('The Run branch name is not valid.');
      });
  }

  /** Runs a Git step; a Git failure becomes a clear {@link PreparationFailedError}. */
  private async step<T>(what: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof GitCommandError) || error.reason === 'aborted') throw error;
      this.logGitError(`Preparation failed while ${what}`, error);
      throw new PreparationFailedError(
        `Preparing the Working copy failed while ${what} (${error.message}). ` +
          'The agent worker log has the details.',
      );
    }
  }

  private logGitError(context: string, error: unknown) {
    const detail =
      error instanceof GitCommandError ? `${error.message}: ${error.stderr.trim()}` : String(error);
    this.options.logger.error(`${context}: ${detail}`);
  }
}

/**
 * The `.git/info/exclude` line that matches exactly `path` (relative, validated): anchored at
 * the top with `/`, backslashes and glob characters escaped, and trailing spaces kept
 * (escaped). A validated path holds no backslash; it is escaped all the same.
 */
export function excludePattern(path: string): string {
  // One pass: a backslash, a glob character, or a space of the trailing run of spaces.
  return `/${path.replace(/[\\*?[]| (?= *$)/g, (character) => `\\${character}`)}`;
}

/** A file-system error's code (e.g. `EACCES`), never its message (it names paths). */
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && /^E[A-Z0-9]+$/.test(code) ? code : 'error';
}

/** A subject within the protocol's limit, never ending in half a surrogate pair. */
function shorten(subject: string): string {
  if (subject.length <= COMMIT_SUBJECT_MAX_LENGTH) return subject;
  const cut = subject.slice(0, COMMIT_SUBJECT_MAX_LENGTH);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Whether the Working copy has the Run branch checked out; false when it cannot be read. */
export async function onBranch(
  git: GitRunner,
  repoDir: string,
  runBranch: string,
  ceiling: string,
): Promise<boolean> {
  const head = await git
    .run(['symbolic-ref', '--quiet', 'HEAD'], {
      cwd: repoDir,
      timeoutMs: GIT_TIMEOUTS.local,
      ceiling,
    })
    .then((ref) => ref.trim())
    .catch(() => '');
  return head === `refs/heads/${runBranch}`;
}

/** Reads a Run's `run.json`; `null` when it is missing or not what the worker writes. */
export async function readRunFile(path: string): Promise<RunFile | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<RunFile>;
    return typeof value.projectId === 'string' && typeof value.composeProjectName === 'string'
      ? (value as RunFile)
      : null;
  } catch {
    return null;
  }
}

/**
 * Removes a Studio-placed file: only a file or symlink at exactly that path, reached through real
 * directories, so nothing outside the Working copy is touched.
 */
async function removeStudioFile(repoDir: string, path: string): Promise<void> {
  const segments = path.split('/');
  let current = repoDir;
  for (const segment of segments.slice(0, -1)) {
    current = posix.join(current, segment);
    const stats = await lstat(current).catch(() => null);
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) return;
  }
  const target = posix.join(current, segments.at(-1)!);
  const stats = await lstat(target).catch(() => null);
  if (!stats || stats.isDirectory()) return;
  await rm(target, { force: true });
}
