import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitOperationError,
  GitRequestRejectedError,
  type MergeDiffFile,
  type MergeDiffLimits,
} from '../../../../application/ports/repository-git.js';
import { SystemGitAdapter } from '../system-git-adapter.js';
import { createFixture, fixtureGit, type Fixture } from './fixtures/fixture-repos.js';

const PROJECT_ID = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const RUN_ID = '0b8e5c2d-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const RUN_BRANCH = 'agent/add-feature-r0b8e5c2d';
const INTEGRATION = 'main';
const ROOMY: MergeDiffLimits = {
  filesMax: 1000,
  filePatchMaxBytes: 512 * 1024,
  patchMaxBytes: 4 * 1024 * 1024,
};

const numbered = (count: number, prefix = 'line') =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i}\n`).join('');

/**
 * The merge review's Git operations against the real `git` and a local `file` remote. Linux only:
 * the adapter refuses other platforms. CI runs them on ubuntu-24.04; they must not skip there.
 */
describe.runIf(process.platform === 'linux')('merge review on Linux (real git)', () => {
  let root: string;
  let dataDir: string;
  let tempRoot: string;
  let fixture: Fixture;

  function adapter(): SystemGitAdapter {
    return new SystemGitAdapter({
      dataDir,
      allowedTransports: ['ssh', 'https', 'file'],
      cloneTimeoutMs: 60_000,
      fetchTimeoutMs: 60_000,
      maxCloneBytes: 50 * 1024 * 1024,
      maxProcessMemoryBytes: 2 * 1024 ** 3,
      tempRoot,
      log: () => undefined,
      allowPrivateRemotes: true,
    });
  }

  const clonePath = () => join(dataDir, 'clones', `${PROJECT_ID}.git`);
  const headOf = (branch: string) =>
    fixtureGit(fixture.path, ['rev-parse', `refs/heads/${branch}`]);
  const refsOfClone = () => fixtureGit(clonePath(), ['for-each-ref', '--format=%(refname)']);

  /** Commits `change` on `branch` (started at `base`), pushes it, and returns to `main`. */
  function commitOn(branch: string, base: string, change: (work: string) => void): string {
    const { work } = fixture;
    const main = headOf('main');
    fixtureGit(work, ['checkout', '--quiet', '-B', branch, headOf(base)]);
    change(work);
    fixtureGit(work, ['add', '--all']);
    fixtureGit(work, ['commit', '--quiet', '--allow-empty', '-m', 'change']);
    fixtureGit(work, ['push', '--quiet', '--force', fixture.path, `HEAD:refs/heads/${branch}`]);
    const commit = fixtureGit(work, ['rev-parse', 'HEAD']);
    fixtureGit(work, ['checkout', '--quiet', '-B', 'main', main]);
    return commit;
  }

  const write = (work: string, path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), content);
  };

  async function cloned() {
    const git = adapter();
    await git.clone(PROJECT_ID, fixture.url, INTEGRATION);
    return git;
  }

  async function diff(limits: MergeDiffLimits = ROOMY) {
    const git = await cloned();
    const { runCommit, integrationCommit } = await git.fetchForReview(
      PROJECT_ID,
      fixture.url,
      INTEGRATION,
      RUN_ID,
      RUN_BRANCH,
    );
    return git.mergeDiff(PROJECT_ID, runCommit, integrationCommit, limits);
  }

  async function computed(limits?: MergeDiffLimits) {
    const outcome = await diff(limits);
    if (outcome.status !== 'computed') throw new Error(`expected a diff, got ${outcome.status}`);
    return outcome;
  }

  const byPath = (files: MergeDiffFile[], path: string) => files.find((f) => f.path === path);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'studio-review-test-'));
    dataDir = join(root, 'data');
    tempRoot = join(root, 'tmp');
    await Promise.all([mkdir(dataDir), mkdir(tempRoot), mkdir(join(root, 'fixtures'))]);
    fixture = createFixture(join(root, 'fixtures'), 'app', {
      'README.md': '# app\n',
      'src/keep.txt': 'one\ntwo\nthree\n',
      'src/old-name.txt': 'rename me\nwith some content\nthat stays\nthe same\n',
      'src/gone.txt': 'delete me\n',
    });
  });

  afterEach(async () => {
    expect(await readdir(tempRoot)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  describe('fetch for review', () => {
    it('fetches both branches, answers both commits and never checks the Run branch out', async () => {
      const runCommit = commitOn(RUN_BRANCH, 'main', (work) => write(work, 'src/new.txt', 'new\n'));
      const git = await cloned();

      await expect(
        git.fetchForReview(PROJECT_ID, fixture.url, INTEGRATION, RUN_ID, RUN_BRANCH),
      ).resolves.toEqual({ runCommit, integrationCommit: headOf('main') });
      expect(refsOfClone()).toBe(`refs/heads/main\nrefs/studio/review/${RUN_ID}`);
      expect(existsSync(join(clonePath(), 'src'))).toBe(false);
    });

    it('follows the Run branch and the Integration branch when they move', async () => {
      commitOn(RUN_BRANCH, 'main', (work) => write(work, 'src/new.txt', 'new\n'));
      const git = await cloned();
      await git.fetchForReview(PROJECT_ID, fixture.url, INTEGRATION, RUN_ID, RUN_BRANCH);
      const movedRun = commitOn(RUN_BRANCH, RUN_BRANCH, (work) =>
        write(work, 'src/more.txt', 'm\n'),
      );
      const movedMain = commitOn('main', 'main', (work) => write(work, 'src/other.txt', 'o\n'));

      await expect(
        git.fetchForReview(PROJECT_ID, fixture.url, INTEGRATION, RUN_ID, RUN_BRANCH),
      ).resolves.toEqual({ runCommit: movedRun, integrationCommit: movedMain });
    });

    it('refuses a branch that is not the Run’s own before Git starts', async () => {
      commitOn(RUN_BRANCH, 'main', (work) => write(work, 'src/new.txt', 'new\n'));
      const git = await cloned();

      for (const wrong of ['agent/add-feature-rdeadbeef', 'main', 'feature/x-r0b8e5c2d']) {
        await expect(
          git.fetchForReview(PROJECT_ID, fixture.url, INTEGRATION, RUN_ID, wrong),
        ).rejects.toBeInstanceOf(GitRequestRejectedError);
      }
      await expect(
        git.fetchForReview(PROJECT_ID, fixture.url, INTEGRATION, 'not-a-uuid', RUN_BRANCH),
      ).rejects.toBeInstanceOf(GitRequestRejectedError);
      expect(refsOfClone()).toBe('refs/heads/main');
    });

    it('reports a Run branch that is gone from the remote as branch_not_found', async () => {
      const git = await cloned();

      const error = await git
        .fetchForReview(PROJECT_ID, fixture.url, INTEGRATION, RUN_ID, RUN_BRANCH)
        .then(
          () => null,
          (caught: unknown) => caught,
        );

      expect(error).toBeInstanceOf(GitOperationError);
      expect((error as GitOperationError).reason).toBe('branch_not_found');
    });
  });

  describe('merge diff', () => {
    it('lists what the Integration branch would gain, with each status and its patch', async () => {
      commitOn('main', 'main', (work) => write(work, 'src/main-only.txt', 'main\n'));
      commitOn(RUN_BRANCH, 'main', (work) => {
        write(work, 'src/keep.txt', 'one\nTWO\nthree\n');
        write(work, 'src/new.txt', 'new\n');
        write(work, 'bin.dat', Buffer.from([0, 1, 2, 3, 0, 255]));
        rmSync(join(work, 'src/gone.txt'));
        renameSync(join(work, 'src/old-name.txt'), join(work, 'src/new-name.txt'));
      });

      const { files, truncated } = await computed();

      expect(truncated).toBe(false);
      expect(files.map((f) => [f.path, f.status]).sort()).toEqual([
        ['bin.dat', 'added'],
        ['src/gone.txt', 'deleted'],
        ['src/keep.txt', 'modified'],
        ['src/new-name.txt', 'renamed'],
        ['src/new.txt', 'added'],
      ]);
      expect(byPath(files, 'src/keep.txt')?.patch).toContain('-two\n+TWO\n');
      expect(byPath(files, 'src/new.txt')?.patch).toContain('+++ b/src/new.txt');
      expect(byPath(files, 'src/new-name.txt')).toMatchObject({
        previousPath: 'src/old-name.txt',
        cut: false,
      });
      expect(byPath(files, 'src/new-name.txt')?.patch).toContain('rename from src/old-name.txt');
      expect(byPath(files, 'bin.dat')).toEqual({
        path: 'bin.dat',
        status: 'added',
        binary: true,
        cut: false,
      });
    });

    it('answers no files when the Run branch adds nothing the Integration branch lacks', async () => {
      commitOn(RUN_BRANCH, 'main', (work) => write(work, 'src/new.txt', 'new\n'));
      commitOn('main', 'main', (work) => write(work, 'src/new.txt', 'new\n'));

      await expect(computed()).resolves.toEqual({
        status: 'computed',
        files: [],
        truncated: false,
      });
    });

    it('answers a conflict with the Integration branch', async () => {
      commitOn('main', 'main', (work) => write(work, 'src/keep.txt', 'one\nmain\nthree\n'));
      commitOn(RUN_BRANCH, 'main', (work) => write(work, 'src/keep.txt', 'one\nrun\nthree\n'));

      await expect(diff()).resolves.toEqual({ status: 'conflicting' });
    });

    it('lists at most the files limit and says the diff is cut', async () => {
      commitOn(RUN_BRANCH, 'main', (work) => {
        for (const name of ['a', 'b', 'c', 'd']) write(work, `src/${name}.txt`, `${name}\n`);
      });

      const { files, truncated } = await computed({ ...ROOMY, filesMax: 2 });

      expect(files.map((f) => f.path)).toEqual(['src/a.txt', 'src/b.txt']);
      expect(truncated).toBe(true);
    });

    it('lists a file whose patch is over the file limit without it, and keeps the others', async () => {
      commitOn(RUN_BRANCH, 'main', (work) => {
        write(work, 'src/big.txt', numbered(500));
        write(work, 'src/small.txt', 'small\n');
      });

      const { files, truncated } = await computed({ ...ROOMY, filePatchMaxBytes: 1000 });

      expect(byPath(files, 'src/big.txt')).toEqual({
        path: 'src/big.txt',
        status: 'added',
        cut: true,
      });
      expect(byPath(files, 'src/small.txt')?.patch).toContain('+small');
      expect(truncated).toBe(false);
    });

    it('stops adding patches once the total limit is reached and says the diff is cut', async () => {
      commitOn(RUN_BRANCH, 'main', (work) => {
        write(work, 'src/a.txt', numbered(10, 'alpha'));
        write(work, 'src/b.txt', numbered(10, 'bravo'));
        write(work, 'src/c.txt', numbered(10, 'charlie'));
      });

      const { files, truncated } = await computed({ ...ROOMY, patchMaxBytes: 400 });

      expect(byPath(files, 'src/a.txt')?.patch).toBeDefined();
      expect(files.filter((f) => f.cut).map((f) => f.path)).toEqual(['src/b.txt', 'src/c.txt']);
      expect(truncated).toBe(true);
    });

    it('rejects a malformed commit id before touching the Clone', async () => {
      const git = await cloned();

      await expect(git.mergeDiff(PROJECT_ID, 'main', headOf('main'), ROOMY)).rejects.toBeInstanceOf(
        GitRequestRejectedError,
      );
    });
  });

  describe('hostile branch', () => {
    it('runs no hook, filter, merge driver, text conversion or external diff', async () => {
      const marker = join(root, 'something-ran');
      const script = join(root, 'pwn.sh');
      await writeFile(script, `#!/bin/sh\ntouch ${marker}\ncat\n`);
      await chmod(script, 0o755);
      const attributes = '* filter=pwn diff=pwn merge=pwn\n';
      commitOn('main', 'main', (work) => {
        write(work, '.gitattributes', attributes);
        write(work, 'src/keep.txt', 'one\ntwo\nthree\nmain\n');
      });
      commitOn(RUN_BRANCH, 'main', (work) => {
        write(work, '.gitattributes', attributes);
        write(work, 'src/keep.txt', 'run\none\ntwo\nthree\n');
        write(work, 'hooks/post-merge', `#!/bin/sh\ntouch ${marker}\n`);
        write(work, '.githooks/post-checkout', `#!/bin/sh\ntouch ${marker}\n`);
      });
      const git = await cloned();
      // A Clone whose own configuration names programs for every mechanism a diff could use.
      for (const [key, value] of [
        ['filter.pwn.clean', script],
        ['filter.pwn.smudge', script],
        ['filter.pwn.process', script],
        ['diff.pwn.textconv', script],
        ['diff.pwn.command', script],
        ['diff.external', script],
        ['merge.pwn.driver', `${script} %O %A %B`],
        ['core.hooksPath', join(root, 'no-hooks')],
        ['core.fsmonitor', script],
        ['core.pager', script],
      ] as const) {
        fixtureGit(clonePath(), ['config', key, value]);
      }
      await mkdir(join(clonePath(), 'hooks'), { recursive: true });
      for (const name of ['reference-transaction', 'post-merge', 'post-checkout']) {
        await writeFile(join(clonePath(), 'hooks', name), `#!/bin/sh\ntouch ${marker}\n`);
        await chmod(join(clonePath(), 'hooks', name), 0o755);
      }

      const { runCommit, integrationCommit } = await git.fetchForReview(
        PROJECT_ID,
        fixture.url,
        INTEGRATION,
        RUN_ID,
        RUN_BRANCH,
      );
      const outcome = await git.mergeDiff(PROJECT_ID, runCommit, integrationCommit, ROOMY);

      expect(outcome.status).toBe('computed');
      expect(existsSync(marker)).toBe(false);
    });
  });
});
