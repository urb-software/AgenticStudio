import type { RunPayload } from '@agentic-studio/contracts';
import { lstat, readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { printable } from './agent-definition/bring-up-to-date.js';
import { GIT_TIMEOUTS, GitCommandError, type GitOptions, type GitRunner } from './git.js';
import { studioPathspecs } from './studio-paths.js';
import { PreparationFailedError, type PreparedRun, type WorkingCopies } from './working-copy.js';

/**
 * Bringing a Run branch up to date (Issue #147, security.md section 4): the integration branch
 * is merged into the Run branch, never the other way round, never as a rebase, and the push that
 * follows is the ordinary fast-forward of the Run branch (a merge commit with the pushed tip as
 * its first parent). Everything here is local to the Working copy except the cache's fetch, which
 * goes through the same hardened Git runner as the Run's start; hooks never run.
 */

/** How a bring-up-to-date request started (see {@link BranchUpdatePort.start}). */
export type BranchUpdateStart =
  /** The Run branch has the whole integration branch: nothing to merge, nothing committed. */
  | { outcome: 'already_up_to_date'; commit: string }
  /** The merge commit was made without conflicts; `baseCommit` is the Run branch's commit before. */
  | { outcome: 'merged'; commit: string; baseCommit: string }
  /** The merge stopped on conflicts and is left open in the Working copy. */
  | {
      outcome: 'conflicts';
      commit: string;
      baseCommit: string;
      files: string[];
      moreFiles: number;
    };

/** The branch update port of the worker loop: {@link BranchUpdates} in production. */
export interface BranchUpdatePort {
  /**
   * Fetches the Project's integration branch; when the Run branch already has it, nothing more
   * happens. Otherwise commits what the Working copy has uncommitted (as the Agent account,
   * Studio-placed files left out) and merges it into the Run branch with `--no-ff` and hooks off.
   * Throws {@link PreparationFailedError} when the fetch or the merge could not be done at all;
   * nothing was merged then.
   */
  start(prepared: PreparedRun, run: RunPayload, signal: AbortSignal): Promise<BranchUpdateStart>;
  /**
   * After the agent ended `done`: completes a merge still open in the Working copy. A conflicted
   * text file the agent resolved in the tree but could not stage (a sandbox that cannot write
   * `.git`) is staged when it holds no conflict marker; a file that still does, any conflict that
   * is not a text conflict of two changes, and any unmerged path left throw
   * {@link MergeIncompleteError}. `expected` is the integration branch commit this part merges:
   * when no merge is open any more, it must be in the history (the merge was completed), else the
   * agent aborted or undid it, which throws as well. Returns `completed` when the worker made the
   * merge commit, `null` when no merge was open and nothing is expected.
   */
  complete(
    prepared: PreparedRun,
    run: RunPayload,
    signal: AbortSignal,
    expected?: string,
  ): Promise<{ mergedCommit: string; completed: boolean } | null>;
  /**
   * Aborts a merge still open, so the Working copy returns to where it was. With `baseCommit`
   * (the Run branch's commit before the part's merge) a Run branch that moved on from it is also
   * reset to it: a part that did not end well leaves nothing of the update behind (review S3 of
   * #154). The reset moves only the Run branch (checked out first if the agent left it), only back
   * along its history, and never undoes anything already pushed: with `pushedCommit` past the base
   * it does nothing (review R2-1, R2-2). True when anything was undone.
   */
  abort(
    prepared: PreparedRun,
    baseCommit?: string,
    signal?: AbortSignal,
    pushedCommit?: string,
  ): Promise<boolean>;
}

/** The agent ended without resolving every conflict (or left conflict markers in a file). */
export class MergeIncompleteError extends Error {
  constructor(readonly files: readonly string[]) {
    const shown = files.slice(0, 10).map(printable).join(', ');
    const more = files.length > 10 ? ` and ${files.length - 10} more` : '';
    super(
      (files.length > 0
        ? `The agent ended without resolving these conflicts: ${shown}${more}. A conflict in a ` +
          'text file is resolved by editing it; any other kind (binary, deleted on one side, a ' +
          'link) has to be staged with Git.'
        : 'The agent ended without completing the merge: it aborted or undid it.') +
        ' The merge was aborted and nothing was pushed. Bring the branch up to date again to try once more.',
    );
    this.name = 'MergeIncompleteError';
  }
}

export interface BranchUpdatesOptions {
  dataDir: string;
  git: GitRunner;
  /** Caches and refreshes the Project's repository (the one network fetch). */
  workingCopies: Pick<WorkingCopies, 'refreshProjectCache'>;
  /** The Agent account's Git identity, the author and committer of the worker's commits. */
  agentGitName: string;
  agentGitEmail: string;
  logger: { error(message: string): void };
}

/** Where the integration branch is fetched to in the Working copy (outside `refs/heads`). */
const FETCHED_REF = 'refs/studio/integration';
/** Most conflicted files listed for the agent. */
const FILES_LISTED_MAX = 50;
/** Largest file read to look for conflict markers; a larger one counts as unresolved. */
const MARKER_SCAN_MAX_BYTES = 8 * 1024 * 1024;
/** How much of a blob is read to tell text from binary. */
const BINARY_SCAN_BYTES = 8000;
const MERGE_COMMIT_MESSAGE = (integrationBranch: string, runBranch: string) =>
  `Merge ${integrationBranch} into ${runBranch}`;

export class BranchUpdates implements BranchUpdatePort {
  constructor(private readonly options: BranchUpdatesOptions) {}

  async start(
    prepared: PreparedRun,
    run: RunPayload,
    signal: AbortSignal,
  ): Promise<BranchUpdateStart> {
    const { git } = this.options;
    const local = this.local(prepared, signal);
    const branch = run.integrationBranch;
    if (branch.startsWith('-')) {
      throw new PreparationFailedError("The Project's integration branch name is not valid.");
    }
    await git.run(['check-ref-format', `refs/heads/${branch}`], local).catch((error: unknown) => {
      if (error instanceof GitCommandError && error.reason === 'exit') {
        throw new PreparationFailedError("The Project's integration branch name is not valid.");
      }
      throw error;
    });
    if ((await this.mergeHead(prepared, signal)) !== null) {
      throw new PreparationFailedError(
        'A merge is already open in the Working copy, so the branch was not updated.',
      );
    }

    const cacheDir = await this.options.workingCopies.refreshProjectCache(run, signal);
    const tip = await this.fetchIntegration(prepared, cacheDir, branch, signal);
    try {
      // Nothing to merge: nothing is changed, not even a commit of the leftovers (review S9).
      if (await this.contains(prepared, tip, signal)) {
        return { outcome: 'already_up_to_date', commit: tip };
      }
      await this.commitLeftovers(prepared, run, signal);
      const baseCommit = (await git.run(['rev-parse', '--verify', 'HEAD^{commit}'], local)).trim();
      try {
        await git.run(
          [
            'merge',
            '--no-ff',
            '--no-edit',
            '--no-verify',
            '--quiet',
            '-m',
            MERGE_COMMIT_MESSAGE(branch, prepared.runBranch),
            tip,
          ],
          { ...local, config: this.identity() },
        );
        return { outcome: 'merged', commit: tip, baseCommit };
      } catch (error) {
        if (!(error instanceof GitCommandError) || error.reason === 'aborted') throw error;
        if ((await this.mergeHead(prepared, signal)) === null) {
          this.options.logger.error(
            `Merging ${branch} into the Run branch of run ${prepared.runId} failed: ${error.message}: ${error.stderr.trim()}`,
          );
          throw new PreparationFailedError(
            `Merging ${branch} into the Run branch failed (${error.message}); nothing was merged. ` +
              'The agent worker log has the details.',
          );
        }
        const files = await this.unmerged(prepared, signal);
        return {
          outcome: 'conflicts',
          commit: tip,
          baseCommit,
          files: files.slice(0, FILES_LISTED_MAX),
          moreFiles: Math.max(0, files.length - FILES_LISTED_MAX),
        };
      }
    } finally {
      // The merge holds the commit it needs; the helper ref is not kept.
      await git
        .run(['update-ref', '-d', FETCHED_REF], this.local(prepared, AbortSignal.timeout(10_000)))
        .catch(() => undefined);
    }
  }

  async complete(
    prepared: PreparedRun,
    run: RunPayload,
    signal: AbortSignal,
    expected?: string,
  ): Promise<{ mergedCommit: string; completed: boolean } | null> {
    const { git } = this.options;
    const local = this.local(prepared, signal);
    const mergedCommit = await this.mergeHead(prepared, signal);
    if (mergedCommit === null) {
      if (expected === undefined) return null;
      // No merge open: the agent completed it, or aborted or undid it (then it is not merged).
      if (await this.contains(prepared, expected, signal)) {
        return { mergedCommit: expected, completed: false };
      }
      throw new MergeIncompleteError([]);
    }
    // A text conflict the agent resolved but could not stage (its sandbox cannot write `.git`) is
    // staged here, once no conflict marker is left in it. Every other kind of conflict (binary,
    // modified on one side and deleted on the other, a link, a mode) leaves "ours" in the tree
    // without a marker, so only the agent staging its own choice can resolve it (review S5).
    for (const path of await this.unmerged(prepared, signal)) {
      if (
        (await resolvedInTree(prepared.repoDir, path)) &&
        (await this.isResolvedTextConflict(prepared, path, signal))
      ) {
        await git.run(['add', '--all', '--', `:(literal)${path}`], local);
      }
    }
    const remaining = await this.unmerged(prepared, signal);
    if (remaining.length > 0) throw new MergeIncompleteError(remaining);
    await this.unstageStudioPaths(prepared, run, local);
    await git.run(['commit', '--quiet', '--no-verify', '--no-edit', '--cleanup=whitespace'], {
      ...local,
      config: this.identity(),
    });
    return { mergedCommit, completed: true };
  }

  async abort(
    prepared: PreparedRun,
    baseCommit?: string,
    signal?: AbortSignal,
    pushedCommit?: string,
  ): Promise<boolean> {
    const own = signal ?? AbortSignal.timeout(GIT_TIMEOUTS.local);
    const { git } = this.options;
    try {
      let undone = false;
      if ((await this.mergeHead(prepared, own)) !== null) {
        await git.run(['merge', '--abort'], this.local(prepared, own));
        undone = true;
      }
      if (baseCommit !== undefined) {
        const local = this.local(prepared, own);
        const branchRef = `refs/heads/${prepared.runBranch}`;
        // Never undo what was pushed: a base the pushed commit is past stays.
        if (
          pushedCommit !== undefined &&
          pushedCommit !== baseCommit &&
          (await this.isAncestor(prepared, baseCommit, pushedCommit, own))
        ) {
          return undone;
        }
        // The reset moves the Run branch only: the agent may have left another branch (or none)
        // checked out (review R2-2).
        const onBranch =
          (await git.run(['symbolic-ref', '--quiet', 'HEAD'], local).catch(() => '')).trim() ===
          branchRef;
        if (!onBranch) await git.run(['checkout', '--force', '--quiet', prepared.runBranch], local);
        const head = (await git.run(['rev-parse', '--verify', 'HEAD^{commit}'], local)).trim();
        // Only back along the Run branch's own history, never to a commit it does not contain.
        if (head !== baseCommit && (await this.isAncestor(prepared, baseCommit, 'HEAD', own))) {
          await git.run(['reset', '--hard', '--quiet', baseCommit], local);
          undone = true;
        }
      }
      return undone;
    } catch (error) {
      this.options.logger.error(
        `Undoing the update of run ${prepared.runId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /** Commits what is uncommitted as the Agent account, Studio-placed files left out. */
  private async commitLeftovers(
    prepared: PreparedRun,
    run: RunPayload,
    signal: AbortSignal,
  ): Promise<void> {
    const { git } = this.options;
    const local = this.local(prepared, signal);
    const status = await git.run(
      ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      local,
    );
    if (status.length === 0) return;
    await git.run(['add', '--all'], local);
    await this.unstageStudioPaths(prepared, run, local);
    const staged = await git
      .run(['diff', '--cached', '--quiet'], local)
      .then(() => false)
      .catch((error: unknown) => {
        if (error instanceof GitCommandError && error.exitCode === 1) return true;
        throw error;
      });
    if (!staged) return;
    await git.run(
      [
        'commit',
        '--quiet',
        '--no-verify',
        '--cleanup=whitespace',
        '-m',
        'agent: save the changes left in the working copy before updating the branch',
      ],
      { ...local, config: this.identity() },
    );
  }

  /** Never staged, even if the agent forced them in (an empty list would reset everything). */
  private async unstageStudioPaths(
    prepared: PreparedRun,
    run: RunPayload,
    local: GitOptions,
  ): Promise<void> {
    const studioPaths = await studioPathspecs(this.options.dataDir, prepared, run);
    if (studioPaths.length > 0) {
      await this.options.git.run(['reset', '--quiet', 'HEAD', '--', ...studioPaths], local);
    }
  }

  /**
   * Fetches the integration branch from the Project's cache (local, `file` only; the cache was
   * just refreshed from the remote) and returns the commit it points at.
   */
  private async fetchIntegration(
    prepared: PreparedRun,
    cacheDir: string,
    branch: string,
    signal: AbortSignal,
  ): Promise<string> {
    const { git } = this.options;
    const local = this.local(prepared, signal);
    try {
      await git.run(
        [
          'fetch',
          '--quiet',
          '--no-tags',
          '--no-recurse-submodules',
          '--',
          cacheDir,
          `+refs/heads/${branch}:${FETCHED_REF}`,
        ],
        { ...local, transports: ['file'] },
      );
      return (await git.run(['rev-parse', '--verify', `${FETCHED_REF}^{commit}`], local)).trim();
    } catch (error) {
      if (!(error instanceof GitCommandError) || error.reason === 'aborted') throw error;
      this.options.logger.error(
        `Fetching ${branch} for run ${prepared.runId} failed: ${error.message}: ${error.stderr.trim()}`,
      );
      throw new PreparationFailedError(
        `The integration branch ${branch} could not be fetched (${error.message}); it may have ` +
          'been renamed or removed on the remote.',
      );
    }
  }

  /** Whether `commit` is already part of the Run branch's history. */
  private contains(prepared: PreparedRun, commit: string, signal: AbortSignal): Promise<boolean> {
    return this.isAncestor(prepared, commit, 'HEAD', signal);
  }

  private async isAncestor(
    prepared: PreparedRun,
    ancestor: string,
    descendant: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.options.git.run(
        ['merge-base', '--is-ancestor', ancestor, descendant],
        this.local(prepared, signal),
      );
      return true;
    } catch (error) {
      if (error instanceof GitCommandError && error.reason === 'exit' && error.exitCode === 1) {
        return false;
      }
      throw error;
    }
  }

  /** The commit a merge still open is merging in (`MERGE_HEAD`); `null` when none is open. */
  private async mergeHead(prepared: PreparedRun, signal: AbortSignal): Promise<string | null> {
    try {
      const head = await this.options.git.run(
        ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD^{commit}'],
        this.local(prepared, signal),
      );
      return head.trim() || null;
    } catch (error) {
      if (error instanceof GitCommandError && error.reason === 'exit') return null;
      throw error;
    }
  }

  /** The paths the index still lists as unmerged. */
  private async unmerged(prepared: PreparedRun, signal: AbortSignal): Promise<string[]> {
    const output = await this.options.git.run(
      ['diff', '--name-only', '--diff-filter=U', '-z'],
      this.local(prepared, signal),
    );
    return output.split('\0').filter((path) => path !== '');
  }

  /**
   * Whether the conflict at `path` is two changes to a text file (both sides regular files, neither
   * a binary) that the agent changed: a repository's attributes (`binary`, `-merge`) can make Git
   * leave "ours" in the tree without a marker, so a file still equal to its "ours" version is not
   * resolved (review R2-3). A deleted file counts as changed.
   */
  private async isResolvedTextConflict(
    prepared: PreparedRun,
    path: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const ours = await this.textConflictOurs(prepared, path, signal);
    if (ours === undefined) return false;
    const target = posix.join(prepared.repoDir, path);
    if (!(await lstat(target).catch(() => null))) return true;
    // `--no-filters`: no repository-defined filter driver runs.
    const current = (
      await this.options.git.run(
        ['hash-object', '--no-filters', '--', target],
        this.local(prepared, signal),
      )
    ).trim();
    return current !== ours;
  }

  /**
   * The "ours" blob of a conflict that is two changes to a text file: both sides present as
   * regular files and neither a binary. Only those leave markers in the tree for an agent to
   * resolve. `undefined` for any other kind of conflict.
   */
  private async textConflictOurs(
    prepared: PreparedRun,
    path: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const { git } = this.options;
    const local = this.local(prepared, signal);
    const staged = await git.run(
      ['ls-files', '--unmerged', '-z', '--', `:(literal)${path}`],
      local,
    );
    const sides = new Map<string, { mode: string; blob: string }>();
    for (const entry of staged.split('\0').filter((line) => line !== '')) {
      const [meta] = entry.split('\t');
      const [mode, blob, stage] = (meta ?? '').split(' ');
      if (mode && blob && stage) sides.set(stage, { mode, blob });
    }
    const ours = sides.get('2');
    const theirs = sides.get('3');
    if (!ours || !theirs) return undefined;
    const regular = (mode: string) => mode === '100644' || mode === '100755';
    if (!regular(ours.mode) || !regular(theirs.mode)) return undefined;
    for (const side of [ours, theirs]) {
      const content = await git.run(['cat-file', 'blob', side.blob], {
        ...local,
        maxStdout: BINARY_SCAN_BYTES,
      });
      if (content.includes('\0')) return undefined;
    }
    return ours.blob;
  }

  private identity(): GitOptions['config'] {
    return [
      ['user.name', this.options.agentGitName],
      ['user.email', this.options.agentGitEmail],
      ['commit.gpgSign', 'false'],
    ];
  }

  private local(prepared: PreparedRun, signal: AbortSignal): GitOptions {
    return {
      cwd: prepared.repoDir,
      timeoutMs: GIT_TIMEOUTS.local,
      signal,
      ceiling: this.options.dataDir,
    };
  }
}

/**
 * Whether a conflicted path no longer holds a conflict marker: it was deleted, is not a regular
 * file, or is a file without a `<<<<<<<` / `>>>>>>>` marker line (a larger one than the scan reads
 * counts as unresolved). Never follows a symlink and never reads outside the Working copy.
 */
async function resolvedInTree(repoDir: string, path: string): Promise<boolean> {
  const segments = path.split('/');
  if (segments.some((part) => part === '' || part === '.' || part === '..')) return false;
  let current = repoDir;
  for (const segment of segments.slice(0, -1)) {
    current = posix.join(current, segment);
    const stats = await lstat(current).catch(() => null);
    if (!stats) return true;
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
  }
  const target = posix.join(current, segments.at(-1)!);
  const stats = await lstat(target).catch(() => null);
  if (!stats) return true;
  if (!stats.isFile()) return true;
  if (stats.size > MARKER_SCAN_MAX_BYTES) return false;
  const text = await readFile(target, 'latin1').catch(() => null);
  if (text === null) return false;
  return !/^<{7}(?: |$)/m.test(text) && !/^>{7}(?: |$)/m.test(text);
}
