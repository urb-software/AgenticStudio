import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isUuid } from './run-layout.js';

/** The file in the worker's data directory that keeps its id across restarts. */
export const WORKER_ID_FILE = 'worker-id';

/**
 * The agent worker's id (Issue #102, review R4 of #122): kept in its data directory, so it
 * stays the same across restarts. The Working copies live there too, and Studio hands a
 * delivery retry only to the worker that started the Run: after a restart it is still the
 * same worker. A missing, unreadable or non-regular file (e.g. a symlink) gets a new random id.
 */
export async function loadWorkerId(dataDir: string): Promise<string> {
  const path = join(dataDir, WORKER_ID_FILE);
  // Never read or write through a link (review N1 of #122): only a regular file counts.
  const regular = await lstat(path).then(
    (stats) => stats.isFile(),
    () => false,
  );
  const stored = regular
    ? await readFile(path, 'utf8').then(
        (text) => text.trim(),
        () => '',
      )
    : '';
  if (isUuid(stored)) return stored.toLowerCase();
  const id = randomUUID();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // Whatever is there (a link, a directory, a file without an id) goes; the new file is
  // created exclusively.
  await rm(path, { recursive: true, force: true });
  await writeFile(
    path,
    `${id}
`,
    { flag: 'wx', mode: 0o600 },
  );
  return id;
}
