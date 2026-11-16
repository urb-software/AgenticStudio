import type { Provider } from '@agentic-studio/contracts';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Studio's managed guardrails (Issue #134): the provider CLIs' root-owned configuration (Claude
 * Code's managed settings, Codex's managed configuration and requirements) and the guard script
 * their hooks run. The server setup installs them from the worker's own guardrails folder
 * (`guardrails/managed-files.txt` says which file goes where); the agent user cannot change them.
 * GUARDRAILS, NOT THE SECURITY BOUNDARY (ADR 0002, security.md §2).
 *
 * At start and before every Run step the worker checks a provider's files: each a real file (never
 * a symbolic link), owned by root, writable by nobody else, in a directory only root can change,
 * and byte-equal (SHA-256) to the worker's own copy; and the hooks' interpreter
 * ({@link HOOK_INTERPRETER}) a real root-owned file. Anything else makes the provider unavailable
 * at start, or fails the step. There is no fallback to agent-writable copies.
 */

/** The worker's guardrails folder: `apps/agent-worker/guardrails` (from `src/` and `dist/`). */
export const GUARDRAILS_DIR = fileURLToPath(new URL('../guardrails/', import.meta.url));

/**
 * The Node.js the managed hooks run the guard script with (absolute, root-owned: the server
 * setup's node step installs it). The managed files name it in their hook commands.
 */
export const HOOK_INTERPRETER = '/usr/local/bin/node';

/** The manifest in the guardrails folder: `<provider> <file> <installed path>` per line. */
export const MANAGED_FILES_MANIFEST = 'managed-files.txt';

export interface ManagedFile {
  provider: Provider;
  /** The file in the worker's guardrails folder. */
  source: string;
  /** The absolute path the server setup installs it at. */
  path: string;
}

const PROVIDER_NAMES: readonly string[] = ['claude_code', 'codex'];

/** Reads the manifest. Throws on a malformed line: the worker must not guess. */
export async function readManagedFiles(dir = GUARDRAILS_DIR): Promise<ManagedFile[]> {
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
    // The managed hooks' interpreter (installed by the setup's node step): a hook that cannot
    // start does not block anything, so it must be there and root's too.
    const node = posix.join(this.root, HOOK_INTERPRETER);
    if (
      !(await this.ownedByRoot(posix.dirname(node), 'directory')) ||
      !(await this.ownedByRoot(node, 'file'))
    ) {
      return `managed guardrails missing or changed: ${HOOK_INTERPRETER}`;
    }
    return null;
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

  private async intact(file: ManagedFile): Promise<boolean> {
    const installed = posix.join(this.root, file.path);
    if (!(await this.ownedByRoot(posix.dirname(installed), 'directory'))) return false;
    if (!(await this.ownedByRoot(installed, 'file'))) return false;
    try {
      return (await sha256(installed)) === (await sha256(join(this.dir, file.source)));
    } catch {
      return false;
    }
  }
}
