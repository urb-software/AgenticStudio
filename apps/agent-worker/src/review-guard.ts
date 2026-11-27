import { copyFile, lstat, readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { GIT_TIMEOUTS, GitCommandError, type GitOptions, type GitRunner } from './git.js';
import type { PreparedRun } from './working-copy.js';

/**
 * A review Phase must not change the Working copy: its state is recorded before (HEAD, the branch,
 * every tracked and untracked file as a tree in a temporary index, a copy of the real index) and
 * put back after, whatever the end. Every Git command is the worker's hardened one.
 */

/** How many paths one `checkout-index` call names. */
const CHECKOUT_CHUNK = 100;

/** The recorded state of a Working copy. */
export interface WorkingCopySnapshot {
  readonly repoDir: string;
  readonly runDir: string;
  /** The ref HEAD names; `null` when HEAD is detached. */
  readonly headRef: string | null;
  /** The commit HEAD pointed to. */
  readonly headCommit: string;
  /** The tree of every tracked and untracked (not ignored) file. */
  readonly tree: string;
  /** Where the real index was copied to; `null` when the Working copy had none. */
  readonly indexCopy: string | null;
  /** Where the real index is. */
  readonly indexFile: string;
}

/** What a restore found and undid. */
export interface RestoreReport {
  /** Whether anything differed: HEAD, the branch, a file. */
  restored: boolean;
  headMoved: boolean;
  /** Files the Phase added, which were removed. */
  added: number;
  /** Files the Phase changed or deleted, which were written back. */
  changed: number;
}

/** The Working copy could not be put back; nothing of it can be trusted, so the Run must end. */
export class RestoreFailedError extends Error {
  constructor(detail: string) {
    super(`The Working copy could not be restored after the review Phase: ${detail}`);
    this.name = 'RestoreFailedError';
  }
}

const TEMP_INDEX = 'review-index';
const SAVED_INDEX = 'review-index-before';

export class ReviewGuard {
  constructor(private readonly git: Pick<GitRunner, 'run'>) {}

  private options(repoDir: string, signal?: AbortSignal, indexFile?: string): GitOptions {
    return {
      cwd: repoDir,
      timeoutMs: GIT_TIMEOUTS.local,
      ...(signal === undefined ? {} : { signal }),
      ...(indexFile === undefined ? {} : { indexFile }),
    };
  }

  /** Records the Working copy's state; the real index and the files are not changed. */
  async capture(prepared: PreparedRun, signal?: AbortSignal): Promise<WorkingCopySnapshot> {
    const { repoDir, runDir } = prepared;
    const plain = this.options(repoDir, signal);
    const headRef = await this.git.run(['symbolic-ref', '--quiet', 'HEAD'], plain).then(
      (ref) => ref.trim(),
      (error: unknown) => {
        // Exit 1: HEAD is detached.
        if (error instanceof GitCommandError && error.reason === 'exit') return null;
        throw error;
      },
    );
    const headCommit = (
      await this.git.run(['rev-parse', '--verify', 'HEAD^{commit}'], plain)
    ).trim();
    const indexFile = await this.realIndex(repoDir, signal);
    const indexCopy = posix.join(runDir, SAVED_INDEX);
    const hadIndex = await copyFile(indexFile, indexCopy).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return false;
      },
    );
    const tree = await this.worktreeTree(prepared, hadIndex ? indexCopy : null, signal);
    return {
      repoDir,
      runDir,
      headRef,
      headCommit,
      tree,
      indexCopy: hadIndex ? indexCopy : null,
      indexFile,
    };
  }

  /**
   * Puts the Working copy back as {@link capture} recorded it and checks that it is. Throws
   * {@link RestoreFailedError} when it cannot, or still differs afterwards.
   */
  async restore(snapshot: WorkingCopySnapshot): Promise<RestoreReport> {
    const { repoDir, runDir } = snapshot;
    const prepared = { repoDir, runDir };
    try {
      const headMoved = await this.restoreHead(snapshot);
      const current = await this.worktreeTree(prepared, snapshot.indexCopy);
      let added = 0;
      let changed = 0;
      if (current !== snapshot.tree) {
        const differences = await this.differences(snapshot, current);
        for (const path of differences.added) await this.removeFile(repoDir, path);
        added = differences.added.length;
        changed = differences.changed.length;
        await this.writeBack(snapshot, differences.changed);
      }
      await this.restoreIndex(snapshot);
      const after = await this.worktreeTree(prepared, snapshot.indexCopy);
      const head = await this.git.run(
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        this.options(repoDir),
      );
      if (after !== snapshot.tree || head.trim() !== snapshot.headCommit) {
        throw new RestoreFailedError('it still differs from the state before the Phase.');
      }
      return { restored: headMoved || added > 0 || changed > 0, headMoved, added, changed };
    } catch (error) {
      if (error instanceof RestoreFailedError) throw error;
      throw new RestoreFailedError(
        error instanceof GitCommandError ? `${error.message}.` : 'an unexpected error occurred.',
      );
    } finally {
      await rm(posix.join(runDir, TEMP_INDEX), { force: true });
      await rm(posix.join(runDir, SAVED_INDEX), { force: true });
    }
  }

  /** Where the Working copy's real index is. */
  private async realIndex(repoDir: string, signal?: AbortSignal): Promise<string> {
    const path = (
      await this.git.run(['rev-parse', '--git-path', 'index'], this.options(repoDir, signal))
    ).trim();
    return resolve(repoDir, path);
  }

  /**
   * The tree of the Working copy as `git add --all` would stage it, in a temporary index that
   * starts from `from` (the real index as it was) so tracked files stay tracked.
   */
  private async worktreeTree(
    prepared: Pick<PreparedRun, 'repoDir' | 'runDir'>,
    from: string | null,
    signal?: AbortSignal,
  ): Promise<string> {
    const indexFile = posix.join(prepared.runDir, TEMP_INDEX);
    await rm(indexFile, { force: true });
    try {
      if (from !== null) await copyFile(from, indexFile);
      const withIndex = this.options(prepared.repoDir, signal, indexFile);
      await this.git.run(['add', '--all'], withIndex);
      return (await this.git.run(['write-tree'], withIndex)).trim();
    } finally {
      await rm(indexFile, { force: true });
    }
  }

  /** HEAD and its branch back to what they were; whether either had moved. */
  private async restoreHead(snapshot: WorkingCopySnapshot): Promise<boolean> {
    const options = this.options(snapshot.repoDir);
    const ref = await this.git.run(['symbolic-ref', '--quiet', 'HEAD'], options).then(
      (value) => value.trim(),
      (error: unknown) => {
        if (error instanceof GitCommandError && error.reason === 'exit') return null;
        throw error;
      },
    );
    const commit = (await this.git.run(['rev-parse', '--verify', 'HEAD^{commit}'], options)).trim();
    if (ref === snapshot.headRef && commit === snapshot.headCommit) return false;
    if (snapshot.headRef === null) {
      await this.git.run(['update-ref', '--no-deref', 'HEAD', snapshot.headCommit], options);
      return true;
    }
    await this.git.run(['update-ref', snapshot.headRef, snapshot.headCommit], options);
    await this.git.run(['symbolic-ref', 'HEAD', snapshot.headRef], options);
    return true;
  }

  /** The paths the Phase added, and those it changed or deleted, between the two trees. */
  private async differences(snapshot: WorkingCopySnapshot, current: string) {
    const listing = await this.git.run(
      ['diff-tree', '-r', '--no-renames', '--name-status', '-z', snapshot.tree, current],
      this.options(snapshot.repoDir),
    );
    const parts = listing.split('\0').filter((part) => part !== '');
    const added: string[] = [];
    const changed: string[] = [];
    for (let at = 0; at + 1 < parts.length; at += 2) {
      const [status, path] = [parts[at]!, parts[at + 1]!];
      if (!safeRelative(path)) throw new RestoreFailedError('a path left the Working copy.');
      (status === 'A' ? added : changed).push(path);
    }
    return { added, changed };
  }

  /** Writes the recorded content of `paths` back, whatever is there now. */
  private async writeBack(snapshot: WorkingCopySnapshot, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    const indexFile = posix.join(snapshot.runDir, TEMP_INDEX);
    await rm(indexFile, { force: true });
    const options = this.options(snapshot.repoDir, undefined, indexFile);
    await this.git.run(['read-tree', snapshot.tree], options);
    for (let at = 0; at < paths.length; at += CHECKOUT_CHUNK) {
      await this.git.run(
        ['checkout-index', '--force', '--', ...paths.slice(at, at + CHECKOUT_CHUNK)],
        options,
      );
    }
  }

  /** The real index as it was (or none, when there was none). */
  private async restoreIndex(snapshot: WorkingCopySnapshot): Promise<void> {
    if (snapshot.indexCopy === null) {
      await rm(snapshot.indexFile, { force: true });
      return;
    }
    await copyFile(snapshot.indexCopy, snapshot.indexFile);
  }

  /**
   * Removes a file the Phase added: only a file or symlink at exactly that path, reached through
   * real directories, so nothing outside the Working copy is touched. Directories it leaves empty
   * go too.
   */
  private async removeFile(repoDir: string, path: string): Promise<void> {
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
    for (
      let directory = dirname(target);
      directory.length > repoDir.length;
      directory = dirname(directory)
    ) {
      if ((await readdir(directory).catch(() => ['x'])).length > 0) break;
      await rmdir(directory).catch(() => undefined);
    }
  }
}

/** A path Git listed inside the Working copy: relative, no `..`, no backslash, no control. */
function safeRelative(path: string): boolean {
  return (
    path !== '' &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f]/.test(path) &&
    !path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')
  );
}

/** The Run log's line when a review Phase left the Working copy changed and it was restored. */
export function restoreNotice(report: RestoreReport): string | null {
  if (!report.restored) return null;
  const parts: string[] = [];
  if (report.added > 0) parts.push(`${report.added} added file(s) removed`);
  if (report.changed > 0) parts.push(`${report.changed} changed or deleted file(s) written back`);
  if (report.headMoved) parts.push('HEAD and the Run branch moved back');
  return `The review Phase changed the working copy; it was restored (${parts.join(', ')})`;
}
