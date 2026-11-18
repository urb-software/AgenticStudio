import { lstat, readdir } from 'node:fs/promises';
import { posix } from 'node:path';

/**
 * User-level instruction and skill files of a provider CLI in the agent user's home: loaded in
 * every Run and writable by an agent, so the CLI is not started while any is present (CLI-created
 * entries are allowed by exact name, as real directories). Only names are reported.
 */
export interface UserLevelFiles {
  /** Paths relative to the home directory that must not exist at all. */
  absent: readonly string[];
  /** Directories relative to the home directory that must be absent or hold only `allowed`. */
  empty: readonly { path: string; allowed?: readonly string[] }[];
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/** The `~/`-names of what is present, in the order given. */
export async function presentUserLevelFiles(
  home: string,
  files: UserLevelFiles,
): Promise<string[]> {
  const present: string[] = [];
  for (const path of files.absent) {
    try {
      await lstat(posix.join(home, path));
      present.push(`~/${path}`);
    } catch {
      // Absent.
    }
  }
  for (const { path, allowed = [] } of files.empty) {
    const full = posix.join(home, path);
    try {
      await lstat(full);
    } catch {
      continue; // Absent.
    }
    if (!(await isRealDirectory(full))) {
      present.push(`~/${path}`);
      continue;
    }
    for (const name of (await readdir(full)).sort()) {
      if (allowed.includes(name) && (await isRealDirectory(posix.join(full, name)))) continue;
      present.push(`~/${path}/${name}`);
    }
  }
  return present;
}

/** The refusal for present files, or `null` when there are none. */
export function userLevelFilesProblem(provider: string, present: readonly string[]): string | null {
  if (present.length === 0) return null;
  return (
    `${provider} user-level instruction or skill files present: ${present.join(', ')}; ` +
    'the operator must review them.'
  );
}
