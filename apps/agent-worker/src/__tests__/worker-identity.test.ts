import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkerId, WORKER_ID_FILE } from '../worker-identity.js';

// Review R4 of #122: a delivery retry goes to the worker that started the Run, so the worker
// keeps its id across restarts, in its data directory.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('loadWorkerId', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = join(mkdtempSync(join(tmpdir(), 'studio-worker-id-')), 'data');
  });
  afterEach(() => rmSync(join(dataDir, '..'), { recursive: true, force: true }));

  it('creates an id on the first start and keeps it across restarts', async () => {
    const first = await loadWorkerId(dataDir);

    expect(first).toMatch(UUID);
    expect(readFileSync(join(dataDir, WORKER_ID_FILE), 'utf8').trim()).toBe(first);
    expect(await loadWorkerId(dataDir)).toBe(first);
  });

  it('replaces a file that does not hold an id', async () => {
    await loadWorkerId(dataDir);
    writeFileSync(join(dataDir, WORKER_ID_FILE), 'not an id\n');

    const id = await loadWorkerId(dataDir);

    expect(id).toMatch(UUID);
    expect(readFileSync(join(dataDir, WORKER_ID_FILE), 'utf8').trim()).toBe(id);
  });

  it.skipIf(process.platform === 'win32')(
    'never writes through a symlink put in its place (review N1 of #122)',
    async () => {
      await loadWorkerId(dataDir);
      const outside = join(dataDir, '..', 'outside.txt');
      writeFileSync(outside, 'untouched');
      rmSync(join(dataDir, WORKER_ID_FILE));
      symlinkSync(outside, join(dataDir, WORKER_ID_FILE));

      const id = await loadWorkerId(dataDir);

      expect(id).toMatch(UUID);
      expect(readFileSync(outside, 'utf8')).toBe('untouched');
      expect(lstatSync(join(dataDir, WORKER_ID_FILE)).isFile()).toBe(true);
    },
  );
});
