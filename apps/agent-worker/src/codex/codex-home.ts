import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GUARDRAILS_DIR } from '../managed-guardrails.js';
import { isUuid, runsDirectory } from '../run-layout.js';

/**
 * Studio owns the agent user's Codex configuration: before every step it rewrites `config.toml`
 * (every Working copy untrusted) and `rules/`, removes user-level hooks, and never reads the login
 * or session files. Guardrails, not the security boundary (ADR 0002).
 */

export { GUARDRAILS_DIR };

export const CODEX_GUARDRAIL_FILES = {
  config: 'codex-config.toml',
  rules: 'codex-studio.rules',
} as const;

/** The files Studio writes in the Codex home, relative to it. */
export const CODEX_HOME_FILES = {
  config: 'config.toml',
  rulesDir: 'rules',
  rules: 'rules/studio.rules',
  lock: '.studio-config.lock',
} as const;

/** What earlier versions of Studio wrote in the Codex home, removed before every step. */
export const LEFTOVERS = ['hooks.json', 'studio'] as const;

/** A lock file older than this is left over from a crashed writer and is taken over. */
const STALE_LOCK_MS = 60_000;
const LOCK_POLL_MS = 25;

export interface CodexHomeOptions {
  /** The agent user's home directory; the Codex home is `<home>/.codex`. */
  home: string;
  /** The worker's data directory: every Working copy under it is marked untrusted. */
  dataDir?: string;
  /** Where Studio's templates are (default {@link GUARDRAILS_DIR}). */
  guardrailsDir?: string;
  /** Longest wait for another writer's lock (default 10 s). */
  lockTimeoutMs?: number;
}

/** The Codex home of the agent user. */
export function codexHome(home: string): string {
  return posix.join(home, '.codex');
}

// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const CONTROL_OR_SURROGATE = /[\u0000-\u001f\u007f\ud800-\udfff]/;

/** A TOML basic string for `value`; throws for a value that cannot be one safely. */
export function tomlString(value: string): string {
  if (CONTROL_OR_SURROGATE.test(value)) {
    throw new Error('A Working copy path contains a character Studio does not write to TOML.');
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** The trust entries appended to the template, one per path, in order. */
export function trustEntries(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  const entries = paths.map(
    (path) => `[projects.${tomlString(path)}]\ntrust_level = "untrusted"\n`,
  );
  return (
    '\n# Working copies, written by the agent worker before every Codex Run step: untrusted, so\n' +
    '# Codex loads none of their .codex/ configuration, hooks or rules.\n\n' +
    entries.join('\n')
  );
}

/** Studio's template, checked: it must not hold trust entries or inline hooks of its own. */
export async function readConfigTemplate(dir = GUARDRAILS_DIR): Promise<string> {
  const text = await readFile(join(dir, CODEX_GUARDRAIL_FILES.config), 'utf8');
  if (/^\s*\[+\s*(?:"?projects"?|"?hooks"?)\b/m.test(text)) {
    throw new Error("Studio's Codex template must not define [projects] or [hooks] tables.");
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** The Working copies under the data directory that exist: `<dataDir>/runs/<runId>/repo`. */
async function workingCopies(dataDir: string | undefined): Promise<string[]> {
  if (!dataDir) return [];
  let names: string[];
  try {
    names = await readdir(runsDirectory(dataDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: string[] = [];
  for (const name of names.filter(isUuid).sort()) {
    const repo = posix.join(runsDirectory(dataDir), name, 'repo');
    try {
      const stats = await lstat(repo);
      if (stats.isDirectory()) found.push(repo);
    } catch {
      // No Working copy (yet, or any more).
    }
  }
  return found;
}

/** Each path as given and with symbolic links resolved, each once. */
async function withRealPaths(paths: readonly string[]): Promise<string[]> {
  const all: string[] = [];
  for (const path of paths) {
    all.push(posix.resolve(path));
    try {
      all.push(await realpath(path));
    } catch {
      // Not there (yet): the lexical path only.
    }
  }
  return [...new Set(all)];
}

/** Takes the lock file, waiting for another writer; returns its release. */
async function lock(path: string, timeoutMs: number): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const token = `${process.pid}-${randomUUID()}\n`;
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(token);
      await handle.close();
      // Released only while it is still this writer's lock (never one taken over meanwhile).
      return async () => {
        const held = await readFile(path, 'utf8').catch(() => undefined);
        if (held === token) await unlink(path).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    try {
      const stats = await stat(path);
      if (Date.now() - stats.mtimeMs > STALE_LOCK_MS) {
        await unlink(path).catch(() => undefined);
        continue;
      }
    } catch {
      continue; // Released meanwhile.
    }
    if (Date.now() >= deadline) {
      throw new Error("Studio's Codex configuration is locked by another writer; try again.");
    }
    await delay(LOCK_POLL_MS);
  }
}

/**
 * Makes `path` a real directory Studio manages: a symbolic link or file there is removed, never
 * followed.
 */
async function realDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isDirectory() && !stats.isSymbolicLink()) return;
    await rm(path, { force: true }); // A link or a file: removed itself, never its target.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(path, { mode: 0o700 });
}

/** Writes `content` to `path` through a temporary file and a rename. Owner-only. */
async function replaceFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.studio-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

export interface PreparedCodexHome {
  /** The Codex home written to. */
  home: string;
  /** The paths marked untrusted. */
  untrusted: string[];
}

/**
 * Writes Studio's Codex configuration into the agent user's Codex home, serialised across worker
 * processes with a lock file. `current` are Working copies to mark untrusted besides those under
 * the data directory (the step's own, which may lie elsewhere).
 */
export async function prepareCodexHome(
  options: CodexHomeOptions,
  current: readonly string[] = [],
): Promise<PreparedCodexHome> {
  const home = codexHome(options.home);
  const dir = options.guardrailsDir ?? GUARDRAILS_DIR;
  await mkdir(home, { recursive: true, mode: 0o700 });
  const release = await lock(
    posix.join(home, CODEX_HOME_FILES.lock),
    options.lockTimeoutMs ?? 10_000,
  );
  try {
    const template = await readConfigTemplate(dir);
    const untrusted = await withRealPaths([...(await workingCopies(options.dataDir)), ...current]);
    await replaceFile(
      posix.join(home, CODEX_HOME_FILES.config),
      template + trustEntries(untrusted),
    );

    // No user-level hooks: a hooks file and Studio's earlier hook folder are removed, a link
    // itself and never its target.
    for (const leftover of LEFTOVERS) {
      await rm(posix.join(home, leftover), { recursive: true, force: true });
    }

    // Studio's rules are the only rules: anything else in the folder is removed first.
    const rulesDir = posix.join(home, CODEX_HOME_FILES.rulesDir);
    await realDirectory(rulesDir);
    // fs.rm removes a link itself and never follows links inside a removed directory.
    for (const name of await readdir(rulesDir)) {
      if (name !== posix.basename(CODEX_HOME_FILES.rules)) {
        await rm(posix.join(rulesDir, name), { recursive: true, force: true });
      }
    }
    await replaceFile(
      posix.join(home, CODEX_HOME_FILES.rules),
      await readFile(join(dir, CODEX_GUARDRAIL_FILES.rules), 'utf8'),
    );
    return { home, untrusted };
  } finally {
    await release();
  }
}
