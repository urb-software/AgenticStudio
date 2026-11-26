import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** What the agent gets: Git's executable bit is the only mode that comes from the Repository. */
export const FILE_MODE = 0o644;
export const EXECUTABLE_MODE = 0o755;
export const DIRECTORY_MODE = 0o755;

export interface PlacedFile {
  path: string;
  executable: boolean;
  content: Buffer;
}

/**
 * Writes the files below `dir`, which must not exist yet (its parent must). Each path is joined
 * safely and must stay inside `dir`, else `leaves()` is thrown; files are created exclusively,
 * never through a link and never over an existing file. Starts no process.
 */
export async function writeFiles(
  dir: string,
  files: readonly PlacedFile[],
  leaves: () => Error,
): Promise<void> {
  const root = resolve(dir);
  await mkdir(root, { mode: DIRECTORY_MODE });
  await chmod(root, DIRECTORY_MODE);
  const made = new Set<string>([root]);
  for (const file of files) {
    const target = resolve(root, ...file.path.split('/'));
    const inside = relative(root, target);
    if (inside === '' || inside.startsWith('..') || !target.startsWith(`${root}${sep}`)) {
      throw leaves();
    }
    const parents: string[] = [];
    for (let parent = dirname(target); !made.has(parent); parent = dirname(parent)) {
      parents.unshift(parent);
    }
    for (const parent of parents) {
      await mkdir(parent, { mode: DIRECTORY_MODE });
      await chmod(parent, DIRECTORY_MODE);
      made.add(parent);
    }
    const mode = file.executable ? EXECUTABLE_MODE : FILE_MODE;
    // `wx`: never through a link, never over an existing file.
    await writeFile(join(target), file.content, { flag: 'wx', mode });
    await chmod(target, mode);
  }
}
