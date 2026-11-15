import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isUuid } from './run-layout.js';

/** The file in the worker's data directory that keeps its id across restarts. */
export const WORKER_ID_FILE = 'worker-id';

/**
 * The agent worker's id (Issue #102, review R4 of #122): kept in its data directory, so it
 * stays the same across restarts. The Working copies live there too, and Studio hands a
 * delivery retry only to the worker that started the Run: after a restart it is still the
 * same worker. A missing or unreadable file gets a new random id.
 */
export async function loadWorkerId(dataDir: string): Promise<string> {
  const path = join(dataDir, WORKER_ID_FILE);
  const stored = await readFile(path, 'utf8').then(
    (text) => text.trim(),
    () => '',
  );
  if (isUuid(stored)) return stored.toLowerCase();
  const id = randomUUID();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(path, `${id}\n`, { mode: 0o600 });
  return id;
}
