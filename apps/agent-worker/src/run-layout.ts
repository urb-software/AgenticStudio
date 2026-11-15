import { lstat, mkdir } from 'node:fs/promises';
import { posix } from 'node:path';

/**
 * Names and paths of a Run on the agent side (Issue #98). Paths are built only from
 * identifiers that are validated as UUIDs and are checked to stay inside the worker's data
 * directory, so a crafted identifier cannot point anywhere else. The worker runs on Linux
 * only, so paths are POSIX paths.
 *
 * Layout: `<dataDir>/cache/<projectId>.git` (one cache per Project) and
 * `<dataDir>/runs/<runId>/{repo/, task.md, run.json, result.json, step-processes}` (the Working
 * copy and, beside it and outside the repository, the Task, the Run file, the agent's result
 * and, while a Run step runs, its process groups: Issue #100).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An identifier is not a UUID, or a path built from it would leave the data directory. */
export class UnsafeIdentifierError extends Error {
  constructor(what: string) {
    super(`Refusing an unsafe ${what}.`);
    this.name = 'UnsafeIdentifierError';
  }
}

/** Whether `value` is a UUID (the only identifiers paths are built from). */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

function uuid(value: string, what: string): string {
  if (!isUuid(value)) throw new UnsafeIdentifierError(what);
  return value.toLowerCase();
}

/** `<base>/<name>`, refused unless it lies strictly inside `base`. */
function inside(base: string, ...names: string[]): string {
  if (!posix.isAbsolute(base)) throw new UnsafeIdentifierError('data directory');
  const root = posix.resolve(base);
  const path = posix.resolve(root, ...names);
  if (!path.startsWith(`${root}/`)) throw new UnsafeIdentifierError('path');
  return path;
}

/**
 * Makes sure `path` (the worker's `runs` or `cache` directory) is a real directory, creating
 * it if asked: never a symlink, so no path built under it can lead out of the data directory
 * and nothing removed under it lies elsewhere (review of #117, S1).
 */
export async function assertRealDirectory(path: string, create: boolean): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new UnsafeIdentifierError(
      `data directory (${posix.basename(path)} is not a real directory)`,
    );
  }
}

/** The directory of the Runs' directories. */
export function runsDirectory(dataDir: string): string {
  return inside(dataDir, 'runs');
}

/** The directory of the per-project caches. */
export function cachesDirectory(dataDir: string): string {
  return inside(dataDir, 'cache');
}

/** The file in a Run's directory that lists the process groups of its Run step (Issue #100). */
export const STEP_PROCESSES_FILE = 'step-processes';

export interface RunDirectories {
  /** The Run's own directory. */
  runDir: string;
  /** The Working copy. */
  repoDir: string;
  /** The Task, beside the Working copy. */
  taskFile: string;
  /** What the worker records about the Run (its Project, Run branch, start commit). */
  runFile: string;
  /** The process groups of the Run step in progress, one id per line (Issue #100). */
  processesFile: string;
  /** The agent's structured result of a `done` step, kept for a delivery retry (Issue #102). */
  resultFile: string;
}

export function runDirectories(dataDir: string, runId: string): RunDirectories {
  const runDir = inside(runsDirectory(dataDir), uuid(runId, 'Run id'));
  return {
    runDir,
    repoDir: posix.join(runDir, 'repo'),
    taskFile: posix.join(runDir, 'task.md'),
    runFile: posix.join(runDir, 'run.json'),
    processesFile: posix.join(runDir, STEP_PROCESSES_FILE),
    resultFile: posix.join(runDir, 'result.json'),
  };
}

/** The Project's cache: a bare repository holding every branch of its remote. */
export function cacheDirectory(dataDir: string, projectId: string): string {
  return inside(cachesDirectory(dataDir), `${uuid(projectId, 'Project id')}.git`);
}

/** Longest part of a Run branch name taken from the Task. */
const SLUG_MAX_LENGTH = 40;

/**
 * The Run branch: `agent/<slug>-r<first 8 hex digits of the Run id>`, the slug made from the
 * Task (lowercase ASCII letters, digits and dashes, at most 40 characters; `run` when nothing
 * is left). Unique by construction: no two Runs share an id prefix in practice, and the
 * worker checks the name with `git check-ref-format` before use.
 */
export function runBranchName(task: string, runId: string): string {
  const id = uuid(runId, 'Run id');
  const slug =
    task
      .normalize('NFKD')
      // Accents go (é → e); any other character outside a-z and 0-9 becomes a dash.
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, SLUG_MAX_LENGTH)
      .replace(/-+$/, '') || 'run';
  return `agent/${slug}-r${id.slice(0, 8)}`;
}

/**
 * The Run's own Docker Compose project name, given to its Run steps as `COMPOSE_PROJECT_NAME`,
 * so its containers, networks and volumes can be found and removed with it.
 */
export function composeProjectName(runId: string): string {
  return `studio-run-${uuid(runId, 'Run id').replaceAll('-', '').slice(0, 12)}`;
}
