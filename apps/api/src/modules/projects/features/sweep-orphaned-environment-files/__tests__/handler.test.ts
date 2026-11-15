import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryEnvironmentFileRepository } from '../../../domain/repositories/__tests__/in-memory-environment-file-repository.js';
import { InMemoryEnvironmentFileContents } from '../../../ports/__tests__/in-memory-environment-file-contents.js';
import { SweepOrphanedEnvironmentFilesHandler } from '../handler.js';

// Issue #104: Environment file contents nothing references are deleted after the grace period;
// referenced ones are never touched.

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

describe('SweepOrphanedEnvironmentFilesHandler', () => {
  let contents: InMemoryEnvironmentFileContents;
  let files: InMemoryEnvironmentFileRepository;
  let sweep: SweepOrphanedEnvironmentFilesHandler;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    contents = new InMemoryEnvironmentFileContents();
    files = new InMemoryEnvironmentFileRepository();
    sweep = new SweepOrphanedEnvironmentFilesHandler(files, contents);
  });

  afterEach(() => vi.restoreAllMocks());

  it('deletes only unreferenced contents older than the grace period', async () => {
    const referenced = await contents.store('A=test-only-1');
    const orphan = await contents.store('B=test-only-2');
    await files.save(PROJECT, { path: '.env', sizeBytes: 13, secretRef: referenced });
    contents.ageAll();
    const fresh = await contents.store('C=test-only-3');

    await sweep.sweep();

    expect([...contents.values.keys()].sort()).toEqual([referenced, fresh].sort());
    expect(contents.values.has(orphan)).toBe(false);
  });

  it('never throws when the store is unavailable', async () => {
    contents.failWith = new Error('down');
    await expect(sweep.sweep()).resolves.toBeUndefined();
  });
});
