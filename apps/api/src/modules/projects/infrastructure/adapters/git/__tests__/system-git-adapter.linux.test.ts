import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GitOperationError,
  GitRequestRejectedError,
  type GitFailureReason,
} from '../../../../ports/repository-git.js';
import { SystemGitAdapter, type SystemGitSettings } from '../system-git-adapter.js';
import { addCommit, createFixture, headOf, type Fixture } from './fixtures/fixture-repos.js';

const PROJECT_ID = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OTHER_PROJECT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

/**
 * Integration tests of the Git adapter against the real `git` binary and bare fixture
 * Repositories (`file` added to the transports for these tests only). Linux only: the
 * adapter refuses other platforms. CI runs them on ubuntu-24.04; they must not skip there.
 */
describe.runIf(process.platform === 'linux')('SystemGitAdapter on Linux (real git)', () => {
  let root: string;
  let dataDir: string;
  let tempRoot: string;
  let fixtures: string;
  let logs: string[];

  function adapter(overrides: Partial<SystemGitSettings> = {}): SystemGitAdapter {
    return new SystemGitAdapter({
      dataDir,
      allowedTransports: ['ssh', 'https', 'file'],
      cloneTimeoutMs: 60_000,
      fetchTimeoutMs: 60_000,
      maxCloneBytes: 50 * 1024 * 1024,
      tempRoot,
      log: (message) => logs.push(message),
      ...overrides,
    });
  }

  async function failureOf(promise: Promise<unknown>): Promise<GitOperationError> {
    const error = await promise.then(
      () => {
        throw new Error('expected the operation to fail');
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GitOperationError);
    return error as GitOperationError;
  }

  async function expectReason(promise: Promise<unknown>, reason: GitFailureReason) {
    expect((await failureOf(promise)).reason).toBe(reason);
  }

  const clonesDir = () => join(dataDir, 'clones');
  const clonePath = (id = PROJECT_ID) => join(clonesDir(), `${id}.git`);
  const cloneEntries = async () => (existsSync(clonesDir()) ? readdir(clonesDir()) : []);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'studio-git-test-'));
    dataDir = join(root, 'data');
    tempRoot = join(root, 'tmp');
    fixtures = join(root, 'fixtures');
    await Promise.all([mkdir(dataDir), mkdir(tempRoot), mkdir(fixtures)]);
    logs = [];
  });

  afterEach(async () => {
    // Every operation deletes its private directory (and any SSH key in it).
    expect(await readdir(tempRoot)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  describe('operations', () => {
    let fixture: Fixture;

    beforeEach(() => {
      fixture = createFixture(fixtures, 'app', { 'README.md': '# app\n' }, { branch: 'main' });
      addCommit(fixture, { 'dev.txt': 'dev\n' }, 'dev');
    });

    it('inspects a remote: default branch and whether the branch exists', async () => {
      await expect(adapter().inspectRemote(fixture.url, 'dev')).resolves.toEqual({
        defaultBranch: 'main',
        branchExists: true,
      });
      await expect(adapter().inspectRemote(fixture.url, 'nope')).resolves.toEqual({
        defaultBranch: 'main',
        branchExists: false,
      });
    });

    it('reports a missing repository', async () => {
      await expectReason(
        adapter().inspectRemote(`${fixture.url}-missing`, 'main'),
        'repository_not_found',
      );
    });

    it('clones into a bare Clone derived from the project id and reads the branch commit', async () => {
      const git = adapter();
      const { commit } = await git.clone(PROJECT_ID, fixture.url, 'dev');

      expect(commit).toBe(headOf(fixture, 'dev'));
      expect(await cloneEntries()).toEqual([`${PROJECT_ID}.git`]);
      expect(existsSync(join(clonePath(), 'HEAD'))).toBe(true);
      expect(existsSync(join(clonePath(), 'objects'))).toBe(true);
      // Bare: no working tree, no checked-out files.
      expect(existsSync(join(clonePath(), 'dev.txt'))).toBe(false);
      expect((await readFile(join(clonePath(), 'HEAD'), 'utf8')).trim()).toBe(
        'ref: refs/heads/dev',
      );
      await expect(git.readBranchCommit(PROJECT_ID, 'dev')).resolves.toEqual({ commit });
    });

    it('fetches new commits of the branch into the Clone', async () => {
      const git = adapter();
      await git.clone(PROJECT_ID, fixture.url, 'dev');
      const next = addCommit(fixture, { 'more.txt': 'more\n' }, 'dev');

      await expect(git.fetch(PROJECT_ID, fixture.url, 'dev')).resolves.toEqual({ commit: next });
      await expect(git.readBranchCommit(PROJECT_ID, 'dev')).resolves.toEqual({ commit: next });
    });

    it('removes a Clone, and treats a missing Clone as removed', async () => {
      const git = adapter();
      await git.clone(PROJECT_ID, fixture.url, 'dev');
      await git.clone(OTHER_PROJECT_ID, fixture.url, 'main');

      await git.removeClone(PROJECT_ID);
      await git.removeClone(PROJECT_ID);

      expect(await cloneEntries()).toEqual([`${OTHER_PROJECT_ID}.git`]);
    });

    it('refuses to clone over an existing Clone and to fetch without one', async () => {
      const git = adapter();
      await git.clone(PROJECT_ID, fixture.url, 'dev');
      await expect(git.clone(PROJECT_ID, fixture.url, 'dev')).rejects.toThrow(
        GitRequestRejectedError,
      );
      await expect(git.fetch(OTHER_PROJECT_ID, fixture.url, 'dev')).rejects.toThrow(
        GitRequestRejectedError,
      );
      await expect(git.readBranchCommit(OTHER_PROJECT_ID, 'dev')).rejects.toThrow(
        GitRequestRejectedError,
      );
    });

    it('serializes operations on one project: a concurrent second clone is refused', async () => {
      const git = adapter();
      const results = await Promise.allSettled([
        git.clone(PROJECT_ID, fixture.url, 'dev'),
        git.clone(PROJECT_ID, fixture.url, 'dev'),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const rejected = results.find((result) => result.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(GitRequestRejectedError);
      expect(await cloneEntries()).toEqual([`${PROJECT_ID}.git`]);
    });

    it('removes stale Git lock files before a fetch', async () => {
      const git = adapter();
      await git.clone(PROJECT_ID, fixture.url, 'dev');
      // Left behind by a fetch that was killed while updating refs.
      for (const lock of ['refs/heads/dev.lock', 'packed-refs.lock', 'HEAD.lock', 'shallow.lock']) {
        await writeFile(join(clonePath(), lock), '');
      }
      const next = addCommit(fixture, { 'after-crash.txt': 'x\n' }, 'dev');

      await expect(git.fetch(PROJECT_ID, fixture.url, 'dev')).resolves.toEqual({ commit: next });
    });

    it('fails a clone of a missing branch with branch_not_found and leaves no partial Clone', async () => {
      await expectReason(adapter().clone(PROJECT_ID, fixture.url, 'nope'), 'branch_not_found');
      expect(await cloneEntries()).toEqual([]);
    });

    it('rejects a crafted project id before touching the disk', async () => {
      for (const projectId of ['../../escape', `${PROJECT_ID}/../../x`, '/etc']) {
        await expect(adapter().clone(projectId, fixture.url, 'dev')).rejects.toThrow(
          GitRequestRejectedError,
        );
      }
      expect(existsSync(clonesDir())).toBe(false);
      expect(await readdir(root)).toEqual(expect.not.arrayContaining(['escape', 'x']));
    });

    it('rejects file remotes unless the allowed set includes file', async () => {
      const production = adapter({ allowedTransports: ['ssh', 'https'] });
      await expect(production.inspectRemote(fixture.url, 'dev')).rejects.toThrow(
        GitRequestRejectedError,
      );
      await expect(production.clone(PROJECT_ID, fixture.url, 'dev')).rejects.toThrow(
        GitRequestRejectedError,
      );
      await expect(production.clone(PROJECT_ID, fixture.path, 'dev')).rejects.toThrow(
        GitRequestRejectedError,
      );
      expect(await cloneEntries()).toEqual([]);
    });

    it('passes arguments without a shell: shell syntax in a branch name is inert', async () => {
      const marker = join(root, 'shell-ran');
      const branch = `x$(touch\${IFS}${marker})`;
      await expect(adapter().inspectRemote(fixture.url, branch)).resolves.toMatchObject({
        branchExists: false,
      });
      expect(existsSync(marker)).toBe(false);
    });

    it('redacts Git output returned to the caller and written to the log', async () => {
      const error = await failureOf(adapter().inspectRemote(`${fixture.url}-missing`, 'main'));
      expect(error.detail).toMatch(/does not appear to be a git repository/);
      for (const text of [error.detail, ...logs]) {
        expect(text).not.toContain(root);
        expect(text).not.toContain(fixtures);
      }
      expect(logs).toHaveLength(1);
    });
  });

  describe('hostile fixtures leave the host untouched', () => {
    it('never runs hooks: committed hook files and hooks planted in the Clone', async () => {
      const marker = join(root, 'hook-ran');
      const hook = `#!/bin/sh\ntouch ${marker}\n`;
      const fixture = createFixture(fixtures, 'hooks', {
        'hooks/post-checkout': { executable: hook },
        'hooks/reference-transaction': { executable: hook },
        '.githooks/post-merge': { executable: hook },
      });
      const git = adapter();
      await git.clone(PROJECT_ID, fixture.url, 'main');
      // Simulate a hook that reached the Clone: Git runs reference-transaction on fetch.
      await mkdir(join(clonePath(), 'hooks'), { recursive: true });
      for (const name of ['reference-transaction', 'post-fetch', 'pre-auto-gc']) {
        await writeFile(join(clonePath(), 'hooks', name), hook);
        await chmod(join(clonePath(), 'hooks', name), 0o755);
      }
      addCommit(fixture, { 'next.txt': 'next\n' });

      await git.fetch(PROJECT_ID, fixture.url, 'main');

      expect(existsSync(marker)).toBe(false);
    });

    it('does not recurse into submodules', async () => {
      const inner = createFixture(fixtures, 'inner', { 'inner.txt': 'inner\n' });
      const fixture = createFixture(
        fixtures,
        'outer',
        { 'outer.txt': 'outer\n' },
        { submodule: { path: 'vendor/inner', url: inner.url, commit: headOf(inner) } },
      );
      await adapter().clone(PROJECT_ID, fixture.url, 'main');
      expect(existsSync(join(clonePath(), 'modules'))).toBe(false);
      expect(await readdir(join(clonePath(), 'refs', 'heads'))).toEqual(['main']);
    });

    it('stores symlinks pointing outside the tree as objects, never as links on disk', async () => {
      const outsideTarget = join(root, 'outside-target');
      await writeFile(outsideTarget, 'untouched\n');
      const fixture = createFixture(fixtures, 'symlinks', {
        'escape-relative': { symlink: '../../../../../../etc/passwd' },
        'escape-absolute': { symlink: outsideTarget },
        'nested/dir-link': { symlink: '/' },
      });
      await adapter().clone(PROJECT_ID, fixture.url, 'main');

      expect(await readFile(outsideTarget, 'utf8')).toBe('untouched\n');
      expect(await symlinksUnder(clonePath())).toEqual([]);
    });

    it('stops a clone larger than the size limit and removes the partial Clone', async () => {
      const fixture = createFixture(fixtures, 'large', {
        'blob.bin': randomBytes(3 * 1024 * 1024),
      });
      await expectReason(
        adapter({ maxCloneBytes: 1024 * 1024, sizePollIntervalMs: 20 }).clone(
          PROJECT_ID,
          fixture.url,
          'main',
        ),
        'size_limit',
      );
      expect(await cloneEntries()).toEqual([]);
    });

    it('removes a Clone that a fetch pushed past the size limit', async () => {
      const fixture = createFixture(fixtures, 'growing', { 'small.txt': 'small\n' });
      const git = adapter({ maxCloneBytes: 1024 * 1024, sizePollIntervalMs: 3_600_000 });
      await git.clone(PROJECT_ID, fixture.url, 'main');
      addCommit(fixture, { 'blob.bin': randomBytes(3 * 1024 * 1024) });

      await expectReason(git.fetch(PROJECT_ID, fixture.url, 'main'), 'size_limit');
      expect(await cloneEntries()).toEqual([]);
    });
  });

  describe('time limits and abort kill the whole process tree', () => {
    let server: Server;
    let sockets: Set<Socket>;
    let url: string;

    // An "HTTPS server" that accepts connections and never answers: Git (through its
    // git-remote-https child) waits on the TLS handshake until it is killed.
    beforeAll(async () => {
      sockets = new Set();
      server = createServer((socket) => {
        sockets.add(socket);
        // Read (and drop) what Git sends, so its disconnect is noticed.
        socket.resume();
        socket.on('close', () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      url = `https://127.0.0.1:${address.port}/owner/repo.git`;
    });

    afterAll(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });

    async function expectConnectionsClosed() {
      // The connection is held by git-remote-https, a child of git: it closes only when the
      // whole process group is killed.
      for (let i = 0; i < 40 && sockets.size > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(sockets.size).toBe(0);
    }

    it('times out a clone at the adapter limit and removes the partial Clone', async () => {
      const started = Date.now();
      await expectReason(
        adapter({ cloneTimeoutMs: 1_000 }).clone(PROJECT_ID, url, 'main'),
        'timeout',
      );
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await cloneEntries()).toEqual([]);
      await expectConnectionsClosed();
    });

    it('honours a shorter caller time limit', async () => {
      const started = Date.now();
      await expectReason(adapter().inspectRemote(url, 'main', { timeoutMs: 500 }), 'timeout');
      expect(Date.now() - started).toBeLessThan(10_000);
      await expectConnectionsClosed();
    });

    it('times out a fetch at the adapter fetch limit', async () => {
      const fixture = createFixture(fixtures, 'app', { 'README.md': '# app\n' });
      const git = adapter({ fetchTimeoutMs: 1_000 });
      await git.clone(PROJECT_ID, fixture.url, 'main');
      await expectReason(git.fetch(PROJECT_ID, url, 'main'), 'timeout');
      // The Clone is kept as it was.
      await expect(git.readBranchCommit(PROJECT_ID, 'main')).resolves.toEqual({
        commit: headOf(fixture),
      });
      await expectConnectionsClosed();
    });

    it('aborts on the caller signal', async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      await expect(
        adapter().clone(PROJECT_ID, url, 'main', { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(await cloneEntries()).toEqual([]);
      await expectConnectionsClosed();
    });

    it('rejects an already aborted signal without starting Git', async () => {
      await expect(
        adapter().inspectRemote(url, 'main', { signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(sockets.size).toBe(0);
    });
  });

  describe('start-up version check', () => {
    it('accepts the installed git', async () => {
      await expect(adapter().verifyGitVersion()).resolves.toMatch(/^\d+\.\d+\.\d+$/);
      await expect(adapter().onModuleInit()).resolves.toBeUndefined();
    });
  });
});

async function symlinksUnder(path: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path)) {
    const child = join(path, entry);
    const stats = await lstat(child);
    if (stats.isSymbolicLink()) found.push(child);
    else if (stats.isDirectory()) found.push(...(await symlinksUnder(child)));
  }
  return found;
}
