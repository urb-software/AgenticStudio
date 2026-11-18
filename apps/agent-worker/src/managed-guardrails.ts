import type { Provider } from '@agentic-studio/contracts';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Studio's managed guardrails (root-owned CLI configuration and the guard script, installed by the
 * server setup), checked at start and before every Run step: real root-owned files, writable by
 * nobody else, byte-equal (SHA-256) to the worker's copy; else unavailable, with no fallback.
 */

/** The worker's guardrails folder: `apps/agent-worker/guardrails` (from `src/` and `dist/`). */
export const GUARDRAILS_DIR = fileURLToPath(new URL('../guardrails/', import.meta.url));

/**
 * The Node.js the managed hooks run the guard script with (absolute, root-owned: the server
 * setup's node step installs it). The managed files name it in their hook commands.
 */
export const HOOK_INTERPRETER = '/usr/local/bin/node';

/**
 * The launcher the managed hooks start the interpreter with (`env -i` and a fixed PATH), so nothing
 * of the session's environment reaches the guard. Root-owned (the operating system's coreutils).
 */
export const HOOK_LAUNCHER = '/usr/bin/env';

/**
 * The manifest in the guardrails folder: `<provider> <file> <installed path>` per line, or
 * `<provider> absent <path>` for a managed input of the CLI that must not exist.
 */
export const MANAGED_FILES_MANIFEST = 'managed-files.txt';

export interface ManagedFile {
  provider: Provider;
  /** The file in the worker's guardrails folder. */
  source: string;
  /** The absolute path the server setup installs it at. */
  path: string;
}

/** A managed input of a provider CLI that must not exist (it would add to Studio's policy). */
export interface AbsentPath {
  provider: Provider;
  path: string;
}

const PROVIDER_NAMES: readonly string[] = ['claude_code', 'codex'];

/** The installed files of the manifest. Throws on a malformed line: the worker must not guess. */
export async function readManagedFiles(dir = GUARDRAILS_DIR): Promise<ManagedFile[]> {
  return (await readManifest(dir)).filter((entry) => entry.source !== 'absent');
}

/** The paths the manifest requires to be absent. */
export async function readAbsentPaths(dir = GUARDRAILS_DIR): Promise<AbsentPath[]> {
  return (await readManifest(dir))
    .filter((entry) => entry.source === 'absent')
    .map(({ provider, path }) => ({ provider, path }));
}

async function readManifest(dir: string): Promise<ManagedFile[]> {
  const text = await readFile(join(dir, MANAGED_FILES_MANIFEST), 'utf8');
  const files: ManagedFile[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [provider, source, path, ...rest] = line.split(/\s+/);
    if (
      rest.length > 0 ||
      !provider ||
      !PROVIDER_NAMES.includes(provider) ||
      !source ||
      !/^[A-Za-z0-9._-]+$/.test(source) ||
      !path ||
      !posix.isAbsolute(path) ||
      posix.normalize(path) !== path
    ) {
      throw new Error(`Malformed line in ${MANAGED_FILES_MANIFEST}: ${line}`);
    }
    files.push({ provider: provider as Provider, source, path });
  }
  return files;
}

export interface ManagedGuardrailsOptions {
  /** Where the worker's own copies and the manifest are (default {@link GUARDRAILS_DIR}). */
  dir?: string;
  /** Test seam: a directory the installed paths are taken relative to (default `/`). */
  root?: string;
  /** Test seam: the expected owner of the installed files and their directories (default root). */
  ownerUid?: number;
}

/** Checks a provider's managed guardrails before it is used. */
export interface ManagedGuardrailsCheck {
  /** Why the provider's managed guardrails cannot be trusted, or `null` when they can. */
  problem(provider: Provider): Promise<string | null>;
}

/** The failure of a Run step whose provider's managed guardrails are missing or changed. */
export function managedGuardrailsFailure(providerName: string, problem: string): string {
  return (
    `${providerName}: ${problem}. The operator reinstalls them with the server setup's ` +
    'guardrails step (deploy/setup-server.sh --only guardrails).'
  );
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

export class ManagedGuardrails implements ManagedGuardrailsCheck {
  private readonly dir: string;
  private readonly root: string;
  private readonly ownerUid: number;

  constructor(options: ManagedGuardrailsOptions = {}) {
    this.dir = options.dir ?? GUARDRAILS_DIR;
    this.root = options.root ?? '/';
    this.ownerUid = options.ownerUid ?? 0;
  }

  async problem(provider: Provider): Promise<string | null> {
    for (const file of await readManagedFiles(this.dir)) {
      if (file.provider !== provider) continue;
      if (!(await this.intact(file))) return `managed guardrails missing or changed: ${file.path}`;
    }
    // Other managed inputs the CLI would merge into Studio's policy.
    for (const { provider: owner, path } of await readAbsentPaths(this.dir)) {
      if (owner !== provider) continue;
      if (!(await this.absent(posix.join(this.root, path)))) {
        return `managed guardrails missing or changed: ${path} must not exist`;
      }
    }
    // The managed hooks' launcher and interpreter: they run the guard, so they must be root's
    // too (the interpreter comes from the setup's node step).
    for (const program of [HOOK_LAUNCHER, HOOK_INTERPRETER]) {
      const installed = posix.join(this.root, program);
      if (
        !(await this.rootOnlyPath(posix.dirname(installed))) ||
        !(await this.ownedByRoot(installed, 'file'))
      ) {
        return `managed guardrails missing or changed: ${program}`;
      }
    }
    return null;
  }

  /** Nothing at all at `path` (an unreadable parent counts as present: it cannot be checked). */
  private async absent(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }

  /** Root-owned, not writable by others: a file, or (for its directory) a directory. */
  private async ownedByRoot(path: string, kind: 'file' | 'directory'): Promise<boolean> {
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) return false;
      if (kind === 'file' ? !stats.isFile() : !stats.isDirectory()) return false;
      return stats.uid === this.ownerUid && (stats.mode & 0o022) === 0;
    } catch {
      return false; // Missing or unreadable.
    }
  }

  /**
   * `dir` and every directory above it up to the root are root-owned and writable by nobody
   * else: whoever could write one of them could swap the files between the check and the CLI.
   */
  private async rootOnlyPath(dir: string): Promise<boolean> {
    const top = posix.resolve(this.root);
    for (let current = posix.resolve(dir); ; current = posix.dirname(current)) {
      if (!(await this.ownedByRoot(current, 'directory'))) return false;
      if (current === top || current === posix.dirname(current)) return true;
    }
  }

  private async intact(file: ManagedFile): Promise<boolean> {
    const installed = posix.join(this.root, file.path);
    if (!(await this.rootOnlyPath(posix.dirname(installed)))) return false;
    if (!(await this.ownedByRoot(installed, 'file'))) return false;
    try {
      return (await sha256(installed)) === (await sha256(join(this.dir, file.source)));
    } catch {
      return false;
    }
  }
}
