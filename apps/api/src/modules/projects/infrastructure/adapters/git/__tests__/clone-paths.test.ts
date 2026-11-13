import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitRequestRejectedError } from '../../../../ports/repository-git.js';
import { ClonePaths } from '../clone-paths.js';

const PROJECT_ID = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

describe('ClonePaths', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'studio-clone-paths-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('derives the Clone location from the project id only', () => {
    expect(new ClonePaths(dataDir).clone(PROJECT_ID)).toBe(
      join(dataDir, 'clones', `${PROJECT_ID}.git`),
    );
  });

  it.each([
    '../../../../etc',
    `${PROJECT_ID}/../../../etc`,
    `../${PROJECT_ID}`,
    '/etc/passwd',
    `${PROJECT_ID}\0`,
    `${PROJECT_ID} `,
    PROJECT_ID.toUpperCase(),
    '3f2b8c1e4d5a4b6c9d7e8f9a0b1c2d3e',
    '..',
    '',
  ])('rejects the crafted project id %j', (projectId) => {
    expect(() => new ClonePaths(dataDir).clone(projectId)).toThrow(GitRequestRejectedError);
  });

  it('keeps partial Clones next to the Clone, unique per call', () => {
    const paths = new ClonePaths(dataDir);
    const first = paths.partial(PROJECT_ID);
    expect(first.startsWith(join(dataDir, 'clones', `${PROJECT_ID}.git.partial-`))).toBe(true);
    expect(paths.partial(PROJECT_ID)).not.toBe(first);
  });

  it.runIf(process.platform !== 'win32')(
    'refuses a clones folder replaced by a symlink pointing outside the data directory',
    async () => {
      const outside = await mkdtemp(join(tmpdir(), 'studio-outside-'));
      try {
        await symlink(outside, join(dataDir, 'clones'));
        const paths = new ClonePaths(dataDir);
        await expect(paths.ensureClonesFolder()).rejects.toThrow(GitRequestRejectedError);
        await expect(paths.existingClone(PROJECT_ID)).rejects.toThrow(GitRequestRejectedError);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')('refuses a Clone path replaced by a symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'studio-outside-'));
    try {
      await mkdir(join(dataDir, 'clones'));
      await symlink(outside, join(dataDir, 'clones', `${PROJECT_ID}.git`));
      await expect(new ClonePaths(dataDir).existingClone(PROJECT_ID)).rejects.toThrow(
        GitRequestRejectedError,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reports a missing Clone as null', async () => {
    await expect(new ClonePaths(dataDir).existingClone(PROJECT_ID)).resolves.toBeNull();
  });
});
