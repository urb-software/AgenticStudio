import {
  copyFile,
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
import { join, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isUuid, runsDirectory } from '../run-layout.js';

/**
 * Studio owns the agent user's Codex configuration (Issue #106, coordinator decision on #106).
 * Before every Codex Run step, and after retention removed Working copies, the worker writes, in
 * the agent user's default Codex home (`$HOME/.codex`; `CODEX_HOME` is never set for the CLI):
 *
 * - `config.toml`: the whole file, from Studio's template (`guardrails/codex-config.toml`), plus
 *   one `[projects."<path>"] trust_level = "untrusted"` entry for every existing Working copy
 *   (and the step's own), so no project `.codex/` layer, hook or rule loads (record, finding 3);
 *   whatever an agent wrote into the file is overwritten;
 * - `hooks.json` and `studio/codex-guard.mjs`: Studio's PreToolUse hook;
 * - `rules/studio.rules`: Studio's command rules, as the only file in `rules/`.
 *
 * GUARDRAILS, NOT THE SECURITY BOUNDARY (ADR 0002). Writes are serialised across Run steps and
 * worker processes with a lock file and land by rename, so a starting CLI never reads half a
 * file. The login (`auth.json`) and the session files in the same directory are never read.
 */

/** The worker's guardrails folder: `apps/agent-worker/guardrails` (from `src/` and `dist/`). */
export const GUARDRAILS_DIR = fileURLToPath(new URL('../../guardrails/', import.meta.url));

export const CODEX_GUARDRAIL_FILES = {
  config: 'codex-config.toml',
  hooks: 'codex-hooks.json',
  hook: 'codex-guard.mjs',
  rules: 'codex-studio.rules',
} as const;

/** The files Studio writes in the Codex home, relative to it. */
export const CODEX_HOME_FILES = {
  config: 'config.toml',
  hooks: 'hooks.json',
  hook: 'studio/codex-guard.mjs',
  rulesDir: 'rules',
  rules: 'rules/studio.rules',
  lock: '.studio-config.lock',
} as const;

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
  /** The Node binary that runs the hook (default: the worker's own). */
  nodePath?: string;
  /** Longest wait for another writer's lock (default 10 s). */
  lockTimeoutMs?: number;
}

/** The Codex home of the agent user. */
export function codexHome(home: string): string {
  return posix.join(home, '.codex');
}

/** A POSIX shell word: single-quoted, so the hook command's shell never expands it. */
function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
    '# Codex loads their AGENTS.md but none of their .codex/ configuration, hooks or rules.\n\n' +
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
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return () => unlink(path).catch(() => undefined);
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
 * Writes Studio's Codex configuration into the agent user's Codex home (see the module comment).
 * `current` are Working copies to mark untrusted besides those under the data directory (the
 * step's own, which may lie elsewhere, e.g. in the smoke script).
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

    const hook = posix.join(home, CODEX_HOME_FILES.hook);
    await mkdir(posix.dirname(hook), { recursive: true, mode: 0o700 });
    await copyFile(join(dir, CODEX_GUARDRAIL_FILES.hook), hook);
    const command = `${shellWord(options.nodePath ?? process.execPath)} ${shellWord(hook)}`;
    const hooks = JSON.parse(await readFile(join(dir, CODEX_GUARDRAIL_FILES.hooks), 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    for (const groups of Object.values(hooks.hooks)) {
      for (const group of groups) for (const handler of group.hooks) handler.command = command;
    }
    await replaceFile(
      posix.join(home, CODEX_HOME_FILES.hooks),
      `${JSON.stringify(hooks, null, 2)}\n`,
    );

    // Studio's rules are the only rules: anything else in the folder is removed first.
    const rulesDir = posix.join(home, CODEX_HOME_FILES.rulesDir);
    await mkdir(rulesDir, { recursive: true, mode: 0o700 });
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
