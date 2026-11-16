import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';

/**
 * The complete-install check at worker start (Issue #106, compliance record, technical finding
 * 7): the bare `codex` binary from a release archive is not a complete install (its tools fail
 * without the code-mode host). The supported install is the official standalone installer, which
 * unpacks the package into `$CODEX_HOME/packages/standalone/releases/<version>-<target>/` and
 * links the command on PATH to its `bin/codex`:
 *
 *   <package>/bin/codex
 *   <package>/bin/codex-code-mode-host
 *   <package>/codex-path/rg
 *
 * Method: resolve the configured binary (`CODEX_CLI_BIN`, on PATH or absolute) with symbolic
 * links followed, and require that layout around it. Only file metadata is read, never content,
 * and nothing in the Codex home but the package (never the login or the session files).
 */

/** The package files a complete standalone install has, relative to the package directory. */
export const STANDALONE_PACKAGE_FILES = ['bin/codex-code-mode-host', 'codex-path/rg'] as const;

const INCOMPLETE =
  'The Codex CLI is not a complete install (compliance record, finding 7): its package is ' +
  'missing the code-mode host or its tools. Install it for the agent user with the official ' +
  'standalone installer (CODEX_NON_INTERACTIVE=1) and restart the worker.';

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where `binary` is: itself when it is a path, else the first executable match on `PATH`. */
export async function resolveBinary(
  binary: string,
  path: string | undefined,
): Promise<string | undefined> {
  if (binary.includes('/')) return (await isExecutableFile(binary)) ? binary : undefined;
  for (const dir of (path ?? '').split(':')) {
    if (!dir.startsWith('/')) continue; // A relative PATH entry would depend on the cwd.
    const candidate = posix.join(dir, binary);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/** `null` when the binary is a complete standalone install, else the reason it is not. */
export async function codexInstallProblem(
  binary: string,
  env: Record<string, string | undefined>,
  missing: string,
): Promise<string | null> {
  const found = await resolveBinary(binary, env.PATH);
  if (found === undefined) return missing;
  let real: string;
  try {
    real = await realpath(found);
  } catch {
    return missing;
  }
  if (posix.basename(real) !== 'codex' || posix.basename(posix.dirname(real)) !== 'bin') {
    return INCOMPLETE;
  }
  const pkg = posix.dirname(posix.dirname(real));
  for (const file of STANDALONE_PACKAGE_FILES) {
    if (!(await isExecutableFile(posix.join(pkg, file)))) return INCOMPLETE;
  }
  return null;
}
