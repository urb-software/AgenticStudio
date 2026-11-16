import type { RunPayload } from '@agentic-studio/contracts';
import { lstat, readFile } from 'node:fs/promises';
import { posix } from 'node:path';
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
  /** The Run branch has the whole integration branch: nothing to merge. */
  | { outcome: 'already_up_to_date'; commit: string }
  /** The merge commit was made without conflicts. */
  | { outcome: 'merged'; commit: string }
  /** The merge stopped on conflicts and is left open in the Working copy. */
  | { outcome: 'conflicts'; commit: string; files: string[]; moreFiles: number };

/** The branch update port of the worker loop: {@link BranchUpdates} in production. */
export interface BranchUpdatePort {
  /**
   * Commits what the Working copy has uncommitted (as the Agent account, Studio-placed files left
   * out), fetches the Project's integration branch and merges it into the Run branch with
   * `--no-ff` and hooks off. Throws {@link PreparationFailedError} when the fetch or the merge
   * could not be done at all; nothing is merged then.
   */
  start(prepared: PreparedRun, run: RunPayload, signal: AbortSignal): Promise<BranchUpdateStart>;
  /**
   * After the agent ended `done`: completes a merge still open in the Working copy. Files the
   * agent resolved in the tree but could not stage (a sandbox that cannot write `.git`) are
   * staged; a file that still holds conflict markers, or any unmerged path left, throws
   * {@link MergeIncompleteError}. Returns the integration branch commit the merge brought in, or
   * `null` when no merge was open. `expected` is the commit this part's own merge started with
   * conflicts over: when no merge is open any more, the agent must have completed it itself (the
   * commit is in the history), else it aborted it, which throws {@link MergeIncompleteError}.
   */
  complete(
    prepared: PreparedRun,
    run: RunPayload,
    signal: AbortSignal,
    expected?: string,
  ): Promise<{ mergedCommit: string } | null>;
  /** Aborts a merge still open, so the Working copy returns to where it was; true when one was. */
  abort(prepared: PreparedRun, signal?: AbortSignal): Promise<boolean>;
}

/** The agent ended without resolving every conflict (or left conflict markers in a file). */
export class MergeIncompleteError extends Error {
  constructor(readonly files: readonly string[]) {
    const shown = files.slice(0, 10).map(printable).join(', ');
    const more = files.length > 10 ? ` and ${files.length - 10} more` : '';
    super(
      (files.length > 0
        ? `The agent ended without resolving the merge conflicts (${shown}${more}).`
        : 'The agent ended without completing the merge: it aborted it.') +
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

    await this.commitLeftovers(prepared, run, signal);

    const cacheDir = await this.options.workingCopies.refreshProjectCache(run, signal);
    const tip = await this.fetchIntegration(prepared, cacheDir, branch, signal);
    try {
      if (await this.contains(prepared, tip, signal)) {
        return { outcome: 'already_up_to_date', commit: tip };
      }
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
        return { outcome: 'merged', commit: tip };
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
  ): Promise<{ mergedCommit: string } | null> {
    const { git } = this.options;
    const local = this.local(prepared, signal);
    const mergedCommit = await this.mergeHead(prepared, signal);
    if (mergedCommit === null) {
      if (expected === undefined) return null;
      // No merge open: the agent completed it, or aborted it (then the commit is not merged).
      if (await this.contains(prepared, expected, signal)) return { mergedCommit: expected };
      throw new MergeIncompleteError([]);
    }
    // A resolution the agent could not stage (its sandbox cannot write `.git`) is staged here,
    // but only for a file that no longer holds conflict markers.
    for (const path of await this.unmerged(prepared, signal)) {
      if (await resolvedInTree(prepared.repoDir, path)) {
        await git.run(['add', '--all', '--', `:(literal)${path}`], local);
      }
    }
    const remaining = await this.unmerged(prepared, signal);
    if (remaining.length > 0) throw new MergeIncompleteError(remaining);
    // Never part of the merge commit, even if the agent staged it by force.
    const studioPaths = await studioPathspecs(this.options.dataDir, prepared, run);
    if (studioPaths.length > 0) {
      await git.run(['reset', '--quiet', 'HEAD', '--', ...studioPaths], local);
    }
    await git.run(['commit', '--quiet', '--no-verify', '--no-edit', '--cleanup=whitespace'], {
      ...local,
      config: this.identity(),
    });
    return { mergedCommit };
  }

  async abort(prepared: PreparedRun, signal?: AbortSignal): Promise<boolean> {
    const own = signal ?? AbortSignal.timeout(GIT_TIMEOUTS.local);
    try {
      if ((await this.mergeHead(prepared, own)) === null) return false;
      await this.options.git.run(['merge', '--abort'], this.local(prepared, own));
      return true;
    } catch (error) {
      this.options.logger.error(
        `Aborting the merge of run ${prepared.runId} failed: ${error instanceof Error ? error.message : String(error)}`,
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
    const studioPaths = await studioPathspecs(this.options.dataDir, prepared, run);
    // Never staged, even if the agent forced them in (an empty list would reset everything).
    if (studioPaths.length > 0) {
      await git.run(['reset', '--quiet', 'HEAD', '--', ...studioPaths], local);
    }
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
        `The integration branch ${branch} could not be fetched (${error.message}); the Run was ` +
          'left as it was. It may have been renamed or removed on the remote.',
      );
    }
  }

  /** Whether `commit` is already part of the Run branch's history. */
  private async contains(
    prepared: PreparedRun,
    commit: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.options.git.run(
        ['merge-base', '--is-ancestor', commit, 'HEAD'],
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
 * Whether a conflicted path no longer holds a conflict: it was deleted, is not a regular file, or
 * is a file without a `<<<<<<<` / `>>>>>>>` marker line (a larger one than the scan reads counts
 * as unresolved). Never follows a symlink and never reads outside the Working copy.
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

/** A path for a message: one line, no control characters, not too long. */
function printable(path: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = path.replace(/[\u0000-\u001f\u007f]/g, '?');
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}

/** The first characters of a commit id, for a sentence. */
function shortId(commit: string): string {
  return commit.slice(0, 7);
}

/**
 * What the agent is told after a bring-up-to-date merge (Issue #147). `outcome` says whether the
 * merge commit already exists (no conflicts) or the merge is open with conflicts; `note` is the
 * operator's own words, if any, always shown as theirs.
 */
export function bringUpToDateInstruction(input: {
  integrationBranch: string;
  start: Extract<BranchUpdateStart, { outcome: 'merged' | 'conflicts' }>;
  note: string;
}): string {
  const { integrationBranch, start, note } = input;
  const target = `\`${integrationBranch}\` (commit ${shortId(start.commit)})`;
  const noteText = note.trim() === '' ? '' : `\n\nThe operator's note:\n\n${note.trim()}`;
  const never =
    'Do not rebase, reset, rewrite history or push; Studio pushes the branch itself, as an ordinary update of the Run branch.';
  if (start.outcome === 'merged') {
    return (
      `Studio merged the latest ${target} into this Run branch. The merge commit exists and ` +
      `nothing conflicted. Run the project's checks and fix whatever the update broke, in new ` +
      `commits on this branch. If nothing broke, change nothing. ${never}${noteText}`
    );
  }
  const listed = start.files.map((file) => `- ${printable(file)}`).join('\n');
  const more = start.moreFiles > 0 ? `\n- and ${start.moreFiles} more` : '';
  return (
    `Studio is merging the latest ${target} into this Run branch, and the merge has conflicts ` +
    `in these files:\n\n${listed}${more}\n\nThe working copy is in the middle of that merge. ` +
    `Resolve every conflict so that the result keeps what both sides meant, remove all conflict ` +
    `markers, then run the project's checks and fix whatever the update broke. You may stage the ` +
    `resolved files and complete the merge commit yourself; if you cannot run Git commands, ` +
    `leave the resolved files in the working tree and Studio completes the merge for you. Do not ` +
    `abort the merge. ${never}${noteText}`
  );
}
