import {
  jsonByteLength,
  RUN_DIFF_MAX_BYTES,
  RUN_DIFF_PATH_MAX_LENGTH,
  RUN_DIFF_UNAVAILABLE_MAX_LENGTH,
  type ReportRunDiffRequest,
  type RunDiff,
  type RunDiffFile,
  type RunPayload,
} from '@agentic-studio/contracts';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { RunDiffLimits } from './config.js';
import { studioPathspecs } from './delivery.js';
import { GIT_TIMEOUTS, GitCommandError, type GitOptions, type GitRunner } from './git.js';
import type { PreparedRun } from './working-copy.js';

/**
 * A Run's diffs (Issue #144, ADR 0002: the Working copy is `executions`' own). After every Run
 * step that reports a result the worker takes a snapshot of the Working copy as a Git tree:
 * a copy of its index in the Run's directory (`GIT_INDEX_FILE`), `git add --all`, the
 * Studio-placed paths taken out again, `git write-tree`. Uncommitted and untracked changes are
 * in it, the real index is never touched, and nothing is written to a ref the agent can see.
 * It then diffs the start commit against that tree (the whole Run) and the previous result's
 * tree against it (since the previous result), with rename detection and the configured limits.
 * The previous tree is kept in the Run's directory (`diff-state.json`), beside the Working copy.
 */

/** What the worker sends about a Run's diffs: the report without the worker id. */
export type RunDiffReport = Omit<ReportRunDiffRequest, 'workerId'>;

/** Both diffs, and what `includesUnpushed` was decided from (for a later push). */
export interface ComputedRunDiff {
  report: { run: RunDiff; last: RunDiff };
  /** The snapshot tree of the Working copy. */
  tree: string;
  /** The commit `HEAD` named, and its tree. */
  head: string;
  headTree: string;
  startCommit: string;
}

/** The diff port of the worker loop: {@link RunDiffs} in production. */
export interface RunDiffPort {
  /**
   * Both diffs of the Working copy as it is now. `refresh` (a delivery retry, which reports no
   * result) diffs "since the previous result" from the same tree as the last report did.
   * Throws {@link RunDiffUnavailableError} (its detail is safe to show) or an abort.
   */
  compute(
    prepared: PreparedRun,
    run: RunPayload,
    signal: AbortSignal,
    options?: { refresh?: boolean },
  ): Promise<ComputedRunDiff>;
  /**
   * After the Run branch was pushed: records its tip as pushed and returns the same diffs with
   * `includesUnpushed` decided against it.
   */
  pushed(
    prepared: PreparedRun,
    computed: ComputedRunDiff,
    signal: AbortSignal,
  ): Promise<{ run: RunDiff; last: RunDiff }>;
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

/** What the worker keeps between results (`diff-state.json` in the Run's directory). */
interface DiffState {
  /** The snapshot tree and `HEAD` of the latest result. */
  tree: string;
  head: string;
  /** Those of the result before it: where "since the previous result" started. */
  previousTree: string;
  previousHead: string;
  /** The Run branch tip the worker last pushed, if it pushed. */
  pushedCommit?: string;
}

const DIFF_STATE_FILE = 'diff-state.json';
const DIFF_INDEX_FILE = 'diff.index';
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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
      const tree = await this.snapshot(prepared, run, local);
      const head = (await this.git(['rev-parse', '--verify', 'HEAD^{commit}'], local)).trim();
      const headTree = (await this.git(['rev-parse', '--verify', 'HEAD^{tree}'], local)).trim();
      const state = await this.readState(prepared, local);
      // A result moves the base on to the latest result; a refresh keeps the one it had.
      const base = options.refresh
        ? state && { tree: state.previousTree, head: state.previousHead }
        : state && { tree: state.tree, head: state.head };
      const startCommit = prepared.startCommit;
      const lastBase = base ?? { tree: startCommit, head: startCommit };
      const pushedCommit = state?.pushedCommit;
      const includesUnpushed = unpushed({ tree, head, headTree, startCommit }, pushedCommit);
      const runDiff = await this.diff(startCommit, startCommit, tree, includesUnpushed, local);
      const lastDiff =
        lastBase.tree === startCommit
          ? runDiff
          : await this.diff(lastBase.tree, lastBase.head, tree, includesUnpushed, local);
      await this.writeState(prepared, {
        tree,
        head,
        previousTree: lastBase.tree,
        previousHead: lastBase.head,
        ...(pushedCommit ? { pushedCommit } : {}),
      });
      return { report: { run: runDiff, last: lastDiff }, tree, head, headTree, startCommit };
    } catch (error) {
      throw this.unavailable(prepared, error);
    }
  }

  async pushed(
    prepared: PreparedRun,
    computed: ComputedRunDiff,
    signal: AbortSignal,
  ): Promise<{ run: RunDiff; last: RunDiff }> {
    const local = this.local(prepared, signal);
    const tip = (
      await this.git(['rev-parse', '--verify', `refs/heads/${prepared.runBranch}^{commit}`], local)
    ).trim();
    const state = await this.readState(prepared, local);
    if (state) await this.writeState(prepared, { ...state, pushedCommit: tip });
    const includesUnpushed = unpushed(computed, tip);
    return {
      run: { ...computed.report.run, includesUnpushed },
      last: { ...computed.report.last, includesUnpushed },
    };
  }

  /** The Working copy as a tree, through a temporary copy of its index. */
  private async snapshot(prepared: PreparedRun, run: RunPayload, local: GitOptions) {
    const indexFile = posix.join(prepared.runDir, DIFF_INDEX_FILE);
    await rm(indexFile, { force: true });
    // Starting from the real index keeps `git add` fast (unchanged files are not hashed again).
    await copyFile(posix.join(prepared.repoDir, '.git', 'index'), indexFile).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
    try {
      const withIndex = { ...local, indexFile };
      await this.git(['add', '--all'], withIndex);
      const studioPaths = await studioPathspecs(this.options.dataDir, prepared, run);
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

  /** The kept state, when it is there and well-formed and its trees still exist. */
  private async readState(prepared: PreparedRun, local: GitOptions): Promise<DiffState | null> {
    const text = await readFile(posix.join(prepared.runDir, DIFF_STATE_FILE), 'utf8').catch(
      () => null,
    );
    if (text === null) return null;
    let value: Partial<DiffState>;
    try {
      value = JSON.parse(text) as Partial<DiffState>;
    } catch {
      return null;
    }
    const ids = [value.tree, value.head, value.previousTree, value.previousHead];
    if (!ids.every((id): id is string => typeof id === 'string' && OBJECT_ID.test(id))) {
      return null;
    }
    if (value.pushedCommit !== undefined && !OBJECT_ID.test(String(value.pushedCommit))) {
      return null;
    }
    // The agent can write beside the Working copy: a state naming objects that do not exist
    // is not used (the diff then starts at the start commit).
    for (const id of ids) {
      const present = await this.git(['cat-file', '-e', id], local).then(
        () => true,
        () => false,
      );
      if (!present) return null;
    }
    return value as DiffState;
  }

  private async writeState(prepared: PreparedRun, state: DiffState): Promise<void> {
    await writeFile(
      posix.join(prepared.runDir, DIFF_STATE_FILE),
      `${JSON.stringify(state, null, 2)}\n`,
      { mode: 0o600 },
    );
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
