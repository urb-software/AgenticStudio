import {
  jsonByteLength,
  RUN_DIFF_MAX_BYTES,
  RUN_DIFF_PATH_MAX_LENGTH,
  RUN_DIFF_UNAVAILABLE_MAX_LENGTH,
  type ReportRunDiffRequest,
  type RunDiff,
  type RunDiffFile,
  type RunDiffState,
  type RunPayload,
} from '@agentic-studio/contracts';
import { copyFile, rm } from 'node:fs/promises';
import { posix } from 'node:path';
import type { RunDiffLimits } from './config.js';
import { GIT_TIMEOUTS, GitCommandError, type GitOptions, type GitRunner } from './git.js';
import { studioPathspecs } from './studio-paths.js';
import type { PreparedRun } from './working-copy.js';

/**
 * A Run's diffs (Issue #144, ADR 0002: the Working copy is `executions`' own). After every Run
 * step that reports a result the worker takes a snapshot of the Working copy as a Git tree:
 * a copy of its index in the Run's directory (`GIT_INDEX_FILE`), `git add --all`, the
 * Studio-placed paths taken out again, `git write-tree`. Uncommitted and untracked changes are
 * in it, the real index is never touched, and nothing is written to a ref the agent can see.
 * It then diffs the start commit against that tree (the whole Run) and the previous result's
 * tree against it (since the previous result), with rename detection and the configured limits.
 * Where the diffs stand (the trees and commits of the latest and the previous result, the
 * pushed tip) goes to Studio with the diffs and comes back with a resume or delivery claim
 * (`diffState`, review S-1 of #149): nothing the agent could write decides it.
 */

/** What the worker sends about a Run's diffs: the report without the worker id. */
export type RunDiffReport = Omit<ReportRunDiffRequest, 'workerId'>;

/** Both diffs and where they stand, and what `includesUnpushed` was decided from. */
export interface ComputedRunDiff {
  report: { run: RunDiff; last: RunDiff; state: RunDiffState };
  /** The snapshot tree of the Working copy. */
  tree: string;
  /** The commit `HEAD` named, and its tree with the Studio-placed paths taken out too. */
  head: string;
  headTree: string;
  startCommit: string;
}

/** The diff port of the worker loop: {@link RunDiffs} in production. */
export interface RunDiffPort {
  /**
   * Both diffs of the Working copy as it is now, from the diff state Studio handed back with
   * the claim. `refresh` (a delivery retry, which reports no result) diffs "since the previous
   * result" from the same base as the last report did. Throws {@link RunDiffUnavailableError}
   * (its detail is safe to show) or an abort.
   */
  compute(
    prepared: PreparedRun,
    run: RunPayload,
    signal: AbortSignal,
    options?: { refresh?: boolean },
  ): Promise<ComputedRunDiff>;
  /**
   * After the Run branch was pushed: the same diffs with `includesUnpushed` decided against its
   * tip, which the state records as pushed.
   */
  pushed(
    prepared: PreparedRun,
    computed: ComputedRunDiff,
    signal: AbortSignal,
  ): Promise<{ run: RunDiff; last: RunDiff; state: RunDiffState }>;
}

/** The diffs could not be computed; `detail` is safe to show (no path, no Git output). */
export class RunDiffUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(detail.slice(0, RUN_DIFF_UNAVAILABLE_MAX_LENGTH));
    this.name = 'RunDiffUnavailableError';
  }
}

export interface RunDiffsOptions {
  /** Absolute directory of the caches and the Runs' directories. */
  dataDir: string;
  git: GitRunner;
  limits: RunDiffLimits;
  logger: { error(message: string): void };
}

const DIFF_INDEX_FILE = 'diff.index';

/** Options every diff command gets: no external diff driver, no textconv, no colour. */
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '-M'] as const;

export class RunDiffs implements RunDiffPort {
  constructor(private readonly options: RunDiffsOptions) {}

  async compute(
    prepared: PreparedRun,
    run: RunPayload,
    signal: AbortSignal,
    options: { refresh?: boolean } = {},
  ): Promise<ComputedRunDiff> {
    const local = this.local(prepared, signal);
    try {
      const studioPaths = await studioPathspecs(this.options.dataDir, prepared, run);
      const tree = await this.snapshot(prepared, studioPaths, local, 'worktree');
      const head = (await this.git(['rev-parse', '--verify', 'HEAD^{commit}'], local)).trim();
      // HEAD's tree without the Studio-placed paths too, so a committed one does not count as
      // an uncommitted change for good (review S-4 of #149).
      const headTree = await this.snapshot(prepared, studioPaths, local, 'head');
      const state = await this.usableState(run.diffState, local);
      // A result moves the base on to the latest result; a refresh keeps the one it had.
      const startCommit = prepared.startCommit;
      const base = state
        ? options.refresh
          ? { tree: state.previousTree, commit: state.previousCommit }
          : { tree: state.resultTree, commit: state.resultCommit }
        : { tree: startCommit, commit: startCommit };
      const pushedCommit = state?.pushedCommit;
      const includesUnpushed = unpushed({ tree, head, headTree, startCommit }, pushedCommit);
      const runDiff = await this.diff(startCommit, startCommit, tree, includesUnpushed, local);
      const lastDiff =
        base.tree === startCommit
          ? runDiff
          : await this.diff(base.tree, base.commit, tree, includesUnpushed, local);
      const nextState: RunDiffState = {
        resultTree: tree,
        resultCommit: head,
        previousTree: await this.treeOf(base.tree, local),
        previousCommit: base.commit,
        ...(pushedCommit ? { pushedCommit } : {}),
      };
      return {
        report: { run: runDiff, last: lastDiff, state: nextState },
        tree,
        head,
        headTree,
        startCommit,
      };
    } catch (error) {
      throw this.unavailable(prepared, error);
    }
  }

  async pushed(
    prepared: PreparedRun,
    computed: ComputedRunDiff,
    signal: AbortSignal,
  ): Promise<{ run: RunDiff; last: RunDiff; state: RunDiffState }> {
    const tip = (
      await this.git(
        ['rev-parse', '--verify', `refs/heads/${prepared.runBranch}^{commit}`],
        this.local(prepared, signal),
      )
    ).trim();
    const includesUnpushed = unpushed(computed, tip);
    return {
      run: { ...computed.report.run, includesUnpushed },
      last: { ...computed.report.last, includesUnpushed },
      state: { ...computed.report.state, pushedCommit: tip },
    };
  }

  /**
   * The Working copy (`worktree`) or `HEAD` (`head`) as a tree, the Studio-placed paths taken
   * out, through a temporary index (never the real one).
   */
  private async snapshot(
    prepared: PreparedRun,
    studioPaths: readonly string[],
    local: GitOptions,
    source: 'worktree' | 'head',
  ): Promise<string> {
    const indexFile = posix.join(prepared.runDir, DIFF_INDEX_FILE);
    await rm(indexFile, { force: true });
    try {
      const withIndex = { ...local, indexFile };
      if (source === 'head') {
        await this.git(['read-tree', 'HEAD'], withIndex);
      } else {
        // Starting from the real index keeps `git add` fast (unchanged files are not hashed again).
        await copyFile(posix.join(prepared.repoDir, '.git', 'index'), indexFile).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          },
        );
        await this.git(['add', '--all'], withIndex);
      }
      // Never part of a diff, even if the agent forced them in or committed them.
      if (studioPaths.length > 0) {
        await this.git(
          ['rm', '--cached', '-r', '--quiet', '--ignore-unmatch', '--', ...studioPaths],
          withIndex,
        );
      }
      return (await this.git(['write-tree'], withIndex)).trim();
    } finally {
      await rm(indexFile, { force: true });
    }
  }

  /**
   * The state Studio handed back, when its objects are in this Working copy as the right types
   * (a tree and a commit for each result); otherwise none, and the diffs start at the start
   * commit.
   */
  private async usableState(
    state: RunDiffState | undefined,
    local: GitOptions,
  ): Promise<RunDiffState | null> {
    if (!state) return null;
    const expected: [string | undefined, 'tree' | 'commit'][] = [
      [state.resultTree, 'tree'],
      [state.resultCommit, 'commit'],
      [state.previousTree, 'tree'],
      [state.previousCommit, 'commit'],
      [state.pushedCommit, 'commit'],
    ];
    for (const [id, type] of expected) {
      if (id === undefined) continue;
      const actual = await this.git(['cat-file', '-t', id], local).then(
        (output) => output.trim(),
        () => null,
      );
      if (actual !== type) return null;
    }
    return state;
  }

  /** The tree of a commit, or the id itself when it is a tree. */
  private async treeOf(id: string, local: GitOptions): Promise<string> {
    return (await this.git(['rev-parse', '--verify', `${id}^{tree}`], local)).trim();
  }

  /** One diff from `base` (a commit or tree) to the snapshot `tree`, within the limits. */
  private async diff(
    base: string,
    baseCommit: string,
    tree: string,
    includesUnpushed: boolean,
    local: GitOptions,
  ): Promise<RunDiff> {
    const { limits } = this.options;
    const [numstat, nameStatus] = await Promise.all([
      this.git(['diff', ...DIFF_FLAGS, '--numstat', '-z', base, tree, '--'], local),
      this.git(['diff', ...DIFF_FLAGS, '--name-status', '-z', base, tree, '--'], local),
    ]);
    const counts = parseNumstat(numstat);
    const changes = parseNameStatus(nameStatus);
    let truncated = changes.length > limits.files;
    let budget = limits.patchBytes;
    const files: RunDiffFile[] = [];
    for (const change of changes.slice(0, limits.files)) {
      if (change.path.length > RUN_DIFF_PATH_MAX_LENGTH) {
        truncated = true;
        continue;
      }
      const count = counts.get(change.path) ?? { additions: 0, deletions: 0, binary: false };
      const file: RunDiffFile = {
        path: change.path,
        ...(change.previousPath && change.previousPath.length <= RUN_DIFF_PATH_MAX_LENGTH
          ? { previousPath: change.previousPath }
          : {}),
        status: change.previousPath ? 'renamed' : change.status,
        additions: count.additions,
        deletions: count.deletions,
      };
      if (file.status === 'renamed' && file.previousPath === undefined) {
        // A rename from a path over the limit is listed as an added file.
        file.status = 'added';
      }
      if (count.binary) {
        files.push({ ...file, binary: true });
        continue;
      }
      if (budget <= 0) {
        // The total limit is reached: listed without content.
        truncated = true;
        files.push(file);
        continue;
      }
      const pathspecs = [`:(literal)${change.path}`];
      if (change.previousPath) pathspecs.push(`:(literal)${change.previousPath}`);
      const patch = await this.git(['diff', ...DIFF_FLAGS, base, tree, '--', ...pathspecs], {
        ...local,
        // Enough to tell a patch over the limit; the rest is not kept.
        maxStdout: limits.filePatchBytes + 1,
      });
      const size = jsonByteLength(patch);
      if (patch.length > limits.filePatchBytes || size > limits.filePatchBytes) {
        files.push({ ...file, tooLarge: true });
      } else if (size > budget) {
        truncated = true;
        budget = 0;
        files.push(file);
      } else if (patch.length === 0) {
        files.push(file);
      } else {
        budget -= size;
        files.push({ ...file, patch });
      }
    }
    const diff: RunDiff = { baseCommit, includesUnpushed, truncated, files };
    // Long paths can still make the list too large: the last files give way.
    while (jsonByteLength(diff) > RUN_DIFF_MAX_BYTES && diff.files.length > 0) {
      diff.files.pop();
      diff.truncated = true;
    }
    return diff;
  }

  private git(args: readonly string[], options: GitOptions): Promise<string> {
    return this.options.git.run(args, options);
  }

  private local(prepared: PreparedRun, signal: AbortSignal): GitOptions {
    return {
      cwd: prepared.repoDir,
      timeoutMs: GIT_TIMEOUTS.local,
      signal,
      ceiling: this.options.dataDir,
    };
  }

  /** A clear reason for the operator; Git's own output goes to the worker log only. */
  private unavailable(prepared: PreparedRun, error: unknown): Error {
    if (error instanceof RunDiffUnavailableError) return error;
    if (error instanceof GitCommandError) {
      if (error.reason === 'aborted') return error;
      this.options.logger.error(
        `Computing the diff of run ${prepared.runId} failed: ${error.message}: ${error.stderr.trim()}`,
      );
      return new RunDiffUnavailableError(
        `The changes could not be computed (${error.message}). The agent worker log has the details.`,
      );
    }
    if (error instanceof Error && error.name === 'AbortError') return error;
    this.options.logger.error(
      `Computing the diff of run ${prepared.runId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new RunDiffUnavailableError(
      'The changes could not be computed. The agent worker log has the details.',
    );
  }
}

/**
 * Whether the snapshot holds changes that are not pushed: uncommitted ones (the tree differs
 * from `HEAD`'s), or commits after the start commit other than the pushed tip.
 */
function unpushed(
  snapshot: { tree: string; head: string; headTree: string; startCommit: string },
  pushedCommit: string | undefined,
): boolean {
  if (snapshot.tree !== snapshot.headTree) return true;
  return snapshot.head !== snapshot.startCommit && snapshot.head !== pushedCommit;
}

interface Change {
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'deleted';
}

/** `git diff --name-status -z`: `<status>\0<path>\0`, or `R<score>\0<old>\0<new>\0`. */
export function parseNameStatus(output: string): Change[] {
  const fields = output.split('\0');
  const changes: Change[] = [];
  for (let i = 0; i < fields.length;) {
    const code = fields[i] ?? '';
    if (code === '') {
      i += 1;
      continue;
    }
    if (code.startsWith('R') || code.startsWith('C')) {
      const previousPath = fields[i + 1] ?? '';
      const path = fields[i + 2] ?? '';
      // A copy (not requested) would keep its source: it is shown as an added file.
      changes.push(
        code.startsWith('R')
          ? { path, previousPath, status: 'modified' }
          : { path, status: 'added' },
      );
      i += 3;
      continue;
    }
    const path = fields[i + 1] ?? '';
    changes.push({
      path,
      status: code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified',
    });
    i += 2;
  }
  return changes.filter((change) => change.path !== '');
}

/**
 * `git diff --numstat -z`: `<added>\t<deleted>\t<path>\0`, or for a rename
 * `<added>\t<deleted>\t\0<old>\0<new>\0`; a binary file counts `-\t-`. Keyed by the new path.
 */
export function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const fields = output.split('\0');
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let i = 0; i < fields.length;) {
    const field = fields[i] ?? '';
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(field);
    if (!match) {
      i += 1;
      continue;
    }
    const binary = match[1] === '-' || match[2] === '-';
    const entry = {
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
    };
    if (match[3] === '') {
      counts.set(fields[i + 2] ?? '', entry);
      i += 3;
    } else {
      counts.set(match[3]!, entry);
      i += 1;
    }
  }
  return counts;
}
