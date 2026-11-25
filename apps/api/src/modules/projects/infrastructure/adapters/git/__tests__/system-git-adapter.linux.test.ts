import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GitCloneMissingError,
  GitOperationError,
  GitRequestRejectedError,
  type GitFailureReason,
} from '../../../../application/ports/repository-git.js';
import {
  PRODUCTION_GIT_LIMITS,
  SystemGitAdapter,
  type SystemGitSettings,
} from '../system-git-adapter.js';
import { addCommit, createFixture, headOf, type Fixture } from './fixtures/fixture-repos.js';

const PROJECT_ID = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OTHER_PROJECT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

/**
 * Serves the bare repositories under `root` over smart HTTP with `git http-backend`, in the
 * test's own process tree: the server is not under the adapter's memory bound.
 */
function serveGitOverHttp(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  pathInfo: string,
): void {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks);
    const query = (request.url ?? '').split('?')[1] ?? '';
    const cgi = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: pathInfo,
        QUERY_STRING: query,
        REQUEST_METHOD: request.method ?? 'GET',
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        CONTENT_LENGTH: String(body.length),
        ...(request.headers['content-encoding']
          ? { HTTP_CONTENT_ENCODING: request.headers['content-encoding'] }
          : {}),
        REMOTE_ADDR: '127.0.0.1',
      },
    });
    // git http-backend may exit before reading the whole body (a client killed by the memory
    // bound); the write then fails with EPIPE, which must not surface as an unhandled error.
    cgi.stdin.on('error', () => undefined);
    cgi.stdin.end(body);
    let head = Buffer.alloc(0);
    let headersSent = false;
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (headersSent) {
        response.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const split = head.indexOf('\r\n\r\n');
      if (split < 0) return;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.subarray(0, split).toString('latin1').split('\r\n')) {
        const colon = line.indexOf(':');
        const name = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === 'status') status = parseInt(value, 10);
        else headers[name] = value;
      }
      response.writeHead(status, headers);
      response.write(head.subarray(split + 4));
      headersSent = true;
    });
    cgi.on('close', () => response.end());
  });
}

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
      maxProcessMemoryBytes: 2 * 1024 ** 3,
      tempRoot,
      log: (message) => logs.push(message),
      // The network fixtures listen on 127.0.0.1: an explicit opt-in.
      allowPrivateRemotes: true,
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

    it('tells whether a path is tracked at a commit of the Clone', async () => {
      const git = adapter();
      const { commit } = await git.clone(PROJECT_ID, fixture.url, 'dev');

      await expect(git.isPathTracked(PROJECT_ID, commit, 'README.md')).resolves.toBe(true);
      await expect(git.isPathTracked(PROJECT_ID, commit, 'dev.txt')).resolves.toBe(true);
      await expect(git.isPathTracked(PROJECT_ID, commit, '.env')).resolves.toBe(false);
      await expect(git.isPathTracked(PROJECT_ID, commit, 'config/.env')).resolves.toBe(false);
      // Literal, not a pattern: a glob that would match a tracked file is not tracked itself.
      await expect(git.isPathTracked(PROJECT_ID, commit, '*.md')).resolves.toBe(false);
      await expect(git.isPathTracked(PROJECT_ID, commit, '../x')).rejects.toThrow(
        GitRequestRejectedError,
      );
      await expect(git.isPathTracked(PROJECT_ID, 'HEAD', '.env')).rejects.toThrow(
        GitRequestRejectedError,
      );
      await expect(git.isPathTracked(OTHER_PROJECT_ID, commit, '.env')).rejects.toThrow(
        GitCloneMissingError,
      );
    });

    it('reads a regular file at a commit of the Clone, and nothing else', async () => {
      const inner = createFixture(fixtures, 'preview-inner', { 'inner.txt': 'inner\n' });
      const source = createFixture(
        fixtures,
        'preview-source',
        {
          'compose.yaml': 'services:\n  web:\n    image: nginx\n',
          'deploy/run.yaml': { executable: 'services: {}\n' },
          'big.yaml': 'x'.repeat(2048),
          'link.yaml': { symlink: 'compose.yaml' },
        },
        {
          branch: 'dev',
          submodule: { path: 'vendor/lib', url: inner.url, commit: headOf(inner) },
        },
      );
      const git = adapter();
      const { commit } = await git.clone(PROJECT_ID, source.url, 'dev');
      const read = (path: string, max = 1024) =>
        git.readFileAtCommit(PROJECT_ID, commit, path, max);

      await expect(read('compose.yaml')).resolves.toEqual({
        status: 'found',
        text: 'services:\n  web:\n    image: nginx\n',
      });
      await expect(read('deploy/run.yaml')).resolves.toEqual({
        status: 'found',
        text: 'services: {}\n',
      });
      await expect(read('nope.yaml')).resolves.toEqual({ status: 'missing' });
      await expect(read('deploy/nope.yaml')).resolves.toEqual({ status: 'missing' });
      // A directory, a symlink and a submodule are no regular file.
      await expect(read('deploy')).resolves.toEqual({ status: 'missing' });
      await expect(read('link.yaml')).resolves.toEqual({ status: 'missing' });
      await expect(read('vendor/lib')).resolves.toEqual({ status: 'missing' });
      // Literal, not a pattern.
      await expect(read('*.yaml')).resolves.toEqual({ status: 'missing' });
      // Over the limit, by the object's size.
      await expect(read('big.yaml', 2047)).resolves.toEqual({ status: 'too_large' });
      await expect(read('big.yaml', 2048)).resolves.toMatchObject({ status: 'found' });
      // The Clone is bare: nothing was written to disk besides Git's own files.
      expect(existsSync(join(clonePath(), 'compose.yaml'))).toBe(false);
    });

    it('refuses an unsafe path or commit, and a missing Clone, when reading a file', async () => {
      const git = adapter();
      const { commit } = await git.clone(PROJECT_ID, fixture.url, 'dev');

      for (const path of [
        '../x',
        '/etc/passwd',
        'a/../b',
        'a\\b',
        './compose.yaml',
        'a//b',
        '.git/config',
        '',
        'a\u0000b',
      ]) {
        await expect(git.readFileAtCommit(PROJECT_ID, commit, path, 1024)).rejects.toThrow(
          GitRequestRejectedError,
        );
      }
      await expect(git.readFileAtCommit(PROJECT_ID, 'HEAD', 'README.md', 1024)).rejects.toThrow(
        GitRequestRejectedError,
      );
      await expect(
        git.readFileAtCommit(PROJECT_ID, 'f'.repeat(40), 'README.md', 1024),
      ).rejects.toThrow(GitOperationError);
      await expect(
        git.readFileAtCommit(OTHER_PROJECT_ID, commit, 'README.md', 1024),
      ).rejects.toThrow(GitCloneMissingError);
    });

    it('lists everything tracked below a folder of the Clone, bounded, without a working tree', async () => {
      const inner = createFixture(fixtures, 'agents-inner', { 'inner.txt': 'inner\n' });
      const source = createFixture(
        fixtures,
        'agents-source',
        {
          'README.md': 'top\n',
          'agents/reviewer/AGENT.md': 'one\n',
          'agents/reviewer/notes/a.txt': 'abc',
          'agents/reviewer/run.sh': { executable: '#!/bin/sh\n' },
          'agents/linked/AGENT.md': { symlink: '../reviewer/AGENT.md' },
          'agents/zeta/AGENT.md': 'z\n',
          'agentsfile.txt': 'not below the folder\n',
          'skills/s/SKILL.md': 'skill\n',
        },
        {
          branch: 'dev',
          submodule: { path: 'agents/vendored', url: inner.url, commit: headOf(inner) },
        },
      );
      const git = adapter();
      const { commit } = await git.clone(PROJECT_ID, source.url, 'dev');

      await expect(git.listTreeAtCommit(PROJECT_ID, commit, 'agents', 100)).resolves.toEqual({
        entries: [
          { path: 'agents/linked/AGENT.md', kind: 'symlink', size: 0 },
          { path: 'agents/reviewer/AGENT.md', kind: 'file', size: 4 },
          { path: 'agents/reviewer/notes/a.txt', kind: 'file', size: 3 },
          { path: 'agents/reviewer/run.sh', kind: 'file', size: 10 },
          { path: 'agents/vendored', kind: 'submodule', size: 0 },
          { path: 'agents/zeta/AGENT.md', kind: 'file', size: 2 },
        ],
        truncated: false,
      });
      // Over the entry bound: the first entries only, and it says so.
      await expect(git.listTreeAtCommit(PROJECT_ID, commit, 'agents', 2)).resolves.toEqual({
        entries: [
          { path: 'agents/linked/AGENT.md', kind: 'symlink', size: 0 },
          { path: 'agents/reviewer/AGENT.md', kind: 'file', size: 4 },
        ],
        truncated: true,
      });
      await expect(git.listTreeAtCommit(PROJECT_ID, commit, 'nothing', 100)).resolves.toEqual({
        entries: [],
        truncated: false,
      });
      expect(existsSync(join(clonePath(), 'agents'))).toBe(false);
    });

    it('refuses an unsafe folder or commit, and a missing Clone, when listing a tree', async () => {
      const git = adapter();
      const { commit } = await git.clone(PROJECT_ID, fixture.url, 'dev');

      await expect(git.listTreeAtCommit(PROJECT_ID, commit, '../x', 10)).rejects.toThrow(
        GitRequestRejectedError,
      );
      await expect(git.listTreeAtCommit(PROJECT_ID, 'HEAD', 'agents', 10)).rejects.toThrow(
        GitRequestRejectedError,
      );
      await expect(git.listTreeAtCommit(PROJECT_ID, 'f'.repeat(40), 'agents', 10)).rejects.toThrow(
        GitOperationError,
      );
      await expect(git.listTreeAtCommit(OTHER_PROJECT_ID, commit, 'agents', 10)).rejects.toThrow(
        GitCloneMissingError,
      );
    });

    it('reads several regular files at a commit in one operation, in the order given', async () => {
      const source = createFixture(
        fixtures,
        'agents-read',
        {
          'agents/a/AGENT.md': 'alpha\n',
          'agents/b/AGENT.md': 'x'.repeat(2048),
          'agents/c/AGENT.md': Buffer.from([0xff, 0xfe, 0x00, 0x41]),
          'agents/d/AGENT.md': { symlink: '../a/AGENT.md' },
        },
        { branch: 'dev' },
      );
      const git = adapter();
      const { commit } = await git.clone(PROJECT_ID, source.url, 'dev');

      const reads = await git.readFilesAtCommit(
        PROJECT_ID,
        commit,
        [
          'agents/d/AGENT.md',
          'agents/b/AGENT.md',
          'agents/a/AGENT.md',
          'agents/nope/AGENT.md',
          '../escape',
          'agents/a',
          'agents/c/AGENT.md',
          '*',
        ],
        1024,
      );

      expect(reads.map((read) => [read.path, read.outcome.status])).toEqual([
        ['agents/d/AGENT.md', 'missing'],
        ['agents/b/AGENT.md', 'too_large'],
        ['agents/a/AGENT.md', 'found'],
        ['agents/nope/AGENT.md', 'missing'],
        ['../escape', 'missing'],
        ['agents/a', 'missing'],
        ['agents/c/AGENT.md', 'found'],
        ['*', 'missing'],
      ]);
      expect(reads[2]!.outcome).toEqual({ status: 'found', text: 'alpha\n' });
      // Binary content arrives as text with the replacement character, for the validation to refuse.
      expect((reads[6]!.outcome as { text: string }).text).toContain('�');
    });

    it('reads more files than one Git call lists, and refuses a bad commit or a missing Clone', async () => {
      const files: Record<string, string> = {};
      for (let index = 0; index < 120; index += 1) files[`agents/a${index}/AGENT.md`] = `n${index}`;
      const source = createFixture(fixtures, 'agents-many', files, { branch: 'dev' });
      const git = adapter();
      const { commit } = await git.clone(PROJECT_ID, source.url, 'dev');

      const reads = await git.readFilesAtCommit(PROJECT_ID, commit, Object.keys(files), 1024);

      expect(reads).toHaveLength(120);
      expect(reads.every((read) => read.outcome.status === 'found')).toBe(true);
      await expect(git.readFilesAtCommit(PROJECT_ID, 'HEAD', ['a'], 1)).rejects.toThrow(
        GitRequestRejectedError,
      );
      await expect(git.readFilesAtCommit(PROJECT_ID, 'f'.repeat(40), ['a'], 1)).rejects.toThrow(
        GitOperationError,
      );
      await expect(git.readFilesAtCommit(OTHER_PROJECT_ID, commit, ['a'], 1)).rejects.toThrow(
        GitCloneMissingError,
      );
    });

    it('reads a tree and files while a fetch holds the project lock', async () => {
      const source = createFixture(
        fixtures,
        'agents-locked',
        { 'agents/a/AGENT.md': 'alpha\n' },
        { branch: 'dev' },
      );
      const git = adapter();
      const { commit } = await git.clone(PROJECT_ID, source.url, 'dev');
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      // The lock a running fetch or clone holds, taken by hand.
      const lock = (
        git as unknown as { exclusive(id: string, work: () => Promise<void>): Promise<void> }
      ).exclusive(PROJECT_ID, () => held);
      try {
        const listed = await git.listTreeAtCommit(PROJECT_ID, commit, 'agents', 10);
        const read = await git.readFilesAtCommit(PROJECT_ID, commit, ['agents/a/AGENT.md'], 100);

        expect(listed.entries).toHaveLength(1);
        expect(read[0]!.outcome).toEqual({ status: 'found', text: 'alpha\n' });
      } finally {
        release();
        await lock;
      }
    });

    describe('archiving a commit', () => {
      const archiveFolder = () => join(tempRoot, 'preview-archives');

      afterEach(async () => {
        await rm(archiveFolder(), { recursive: true, force: true });
      });
      const listed = (file: string) =>
        spawnSync('tar', ['-tf', file], { encoding: 'utf8' })
          .stdout.split('\n')
          .filter((name) => name !== '')
          .sort();

      async function archived(git: SystemGitAdapter, commit: string, maxBytes = 1024 * 1024) {
        const outcome = await git.archiveCommit(PROJECT_ID, commit, maxBytes);
        if (outcome.status !== 'archived') throw new Error(`not archived: ${outcome.status}`);
        return outcome.archive;
      }

      async function bytesOf(chunks: AsyncIterable<Uint8Array>) {
        const parts: Buffer[] = [];
        for await (const chunk of chunks) parts.push(Buffer.from(chunk));
        return Buffer.concat(parts);
      }

      it('holds the tracked tree of the commit in an owner-only temporary file until closed', async () => {
        const source = createFixture(
          fixtures,
          'archive-source',
          {
            'compose.yaml': 'services: {}\n',
            'src/app.js': 'console.log(1);\n',
            'link.txt': { symlink: 'compose.yaml' },
          },
          { branch: 'dev' },
        );
        const git = adapter();
        const { commit } = await git.clone(PROJECT_ID, source.url, 'dev');

        const archive = await archived(git, commit);
        const [name, ...others] = await readdir(archiveFolder());
        expect(others).toEqual([]);
        const file = join(archiveFolder(), name!);
        expect((await lstat(file)).mode & 0o777).toBe(0o600);
        expect((await lstat(archiveFolder())).mode & 0o777).toBe(0o700);

        const tracked = spawnSync(
          'git',
          [`--git-dir=${clonePath()}`, 'ls-tree', '-r', '-t', '--name-only', commit],
          { encoding: 'utf8' },
        )
          .stdout.split('\n')
          .filter((entry) => entry !== '');
        expect(listed(file).map((entry) => entry.replace(/\/$/, ''))).toEqual([...tracked].sort());
        const bytes = await bytesOf(archive.chunks());
        expect(bytes.length).toBe(archive.sizeBytes);
        expect(bytes.length).toBe((await lstat(file)).size);

        await archive.close();
        await archive.close();
        expect(existsSync(file)).toBe(false);
      });

      it('archives the tracked tree as stored, whatever attributes the tree itself carries', async () => {
        const source = createFixture(
          fixtures,
          'archive-attributes',
          {
            '.gitattributes': 'ignored.txt export-ignore\nsubst.txt export-subst\n',
            'ignored.txt': 'kept\n',
            'subst.txt': '$Format:%H$\n',
            'plain.txt': 'plain\n',
          },
          { branch: 'dev' },
        );
        const git = adapter();
        const { commit } = await git.clone(PROJECT_ID, source.url, 'dev');

        const archive = await archived(git, commit);
        const [name] = await readdir(archiveFolder());
        const file = join(archiveFolder(), name!);
        const tracked = spawnSync(
          'git',
          [`--git-dir=${clonePath()}`, 'ls-tree', '-r', '--name-only', commit],
          { encoding: 'utf8' },
        )
          .stdout.split('\n')
          .filter((entry) => entry !== '')
          .sort();
        expect(listed(file)).toEqual(tracked);
        expect(tracked).toContain('ignored.txt');
        for (const entry of tracked) {
          const stored = spawnSync(
            'git',
            [`--git-dir=${clonePath()}`, 'show', `${commit}:${entry}`],
            {
              encoding: 'utf8',
            },
          ).stdout;
          const archivedText = spawnSync('tar', ['-xOf', file, entry], { encoding: 'utf8' }).stdout;
          expect(archivedText).toBe(stored);
        }
        expect(spawnSync('tar', ['-xOf', file, 'subst.txt'], { encoding: 'utf8' }).stdout).toBe(
          '$Format:%H$\n',
        );
        await archive.close();
      });

      it('answers commit_missing for a commit the Clone lacks, leaving no file', async () => {
        const git = adapter();
        await git.clone(PROJECT_ID, fixture.url, 'dev');

        await expect(git.archiveCommit(PROJECT_ID, 'f'.repeat(40), 1024 * 1024)).resolves.toEqual({
          status: 'commit_missing',
        });
        expect(existsSync(archiveFolder()) ? await readdir(archiveFolder()) : []).toEqual([]);
      });

      it('answers too_large above the limit and removes the file', async () => {
        const source = createFixture(
          fixtures,
          'archive-big',
          { 'big.bin': randomBytes(64 * 1024).toString('hex') },
          { branch: 'dev' },
        );
        const git = adapter();
        const { commit } = await git.clone(PROJECT_ID, source.url, 'dev');

        await expect(git.archiveCommit(PROJECT_ID, commit, 16 * 1024)).resolves.toEqual({
          status: 'too_large',
        });
        expect(await readdir(archiveFolder())).toEqual([]);
      });

      it('refuses a commit that is not a full id, and a project without a Clone', async () => {
        const git = adapter();
        const { commit } = await git.clone(PROJECT_ID, fixture.url, 'dev');

        await expect(git.archiveCommit(PROJECT_ID, 'HEAD', 1024)).rejects.toThrow(
          GitRequestRejectedError,
        );
        await expect(git.archiveCommit(OTHER_PROJECT_ID, commit, 1024)).rejects.toThrow(
          GitCloneMissingError,
        );
      });

      it('removes archives a crash left behind at start-up', async () => {
        const name = 'archive-3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e.tar';
        const own = join(dataDir, 'tmp', 'preview-archives');
        await mkdir(own, { recursive: true, mode: 0o700 });
        await writeFile(join(own, name), 'x');
        await mkdir(archiveFolder(), { recursive: true, mode: 0o700 });
        await writeFile(join(archiveFolder(), name), 'x');

        // A custom temp root is shared: it keeps a file younger than the clone limit.
        await adapter().onModuleInit();
        expect(existsSync(join(archiveFolder(), name))).toBe(true);
        expect(existsSync(join(own, name))).toBe(true);
        // The default root belongs to the API alone, so nothing in it is live at start-up.
        await adapter({ tempRoot: undefined }).onModuleInit();
        expect(existsSync(join(own, name))).toBe(false);
      });
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
        GitCloneMissingError,
      );
      await expect(git.readBranchCommit(OTHER_PROJECT_ID, 'dev')).rejects.toThrow(
        GitCloneMissingError,
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
      // Git runs reference-transaction on fetch, so a hook of the Clone would reach it.
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
        // Read what Git sends, so its disconnect is noticed.
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
      await expect(git.readBranchCommit(PROJECT_ID, 'main')).resolves.toEqual({
        commit: headOf(fixture),
      });
      await expectConnectionsClosed();
    });

    it('counts time spent waiting for the project lock against the caller limit', async () => {
      const git = adapter({ cloneTimeoutMs: 1_500 });
      const first = git.clone(PROJECT_ID, url, 'main').catch((e: unknown) => e);
      // Queued behind the 1.5 s clone, with a 300 ms budget: it must time out, not run late.
      const queued = git.readBranchCommit(PROJECT_ID, 'main', { timeoutMs: 300 });

      await expect(queued).rejects.toMatchObject({ reason: 'timeout' });
      expect(await first).toMatchObject({ reason: 'timeout' });
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

  describe('HTTPS remotes: pinned to the checked address, redirects refused', () => {
    const HOST = 'git.studio-fixture.test';
    let certDir: string;
    let caFile: string;
    let server: HttpsServer;
    let port: number;
    let requests: { host: string | undefined; url: string | undefined }[];

    // A TLS server with a throwaway certificate for HOST: it answers /moved/… with a redirect
    // to /owner/repo.git and everything else with 404, recording every request.
    beforeAll(async () => {
      certDir = await mkdtemp(join(tmpdir(), 'studio-tls-'));
      caFile = join(certDir, 'cert.pem');
      const keyFile = join(certDir, 'key.pem');
      const generated = spawnSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${HOST}`,
        '-addext',
        `subjectAltName=DNS:${HOST}`,
        '-keyout',
        keyFile,
        '-out',
        caFile,
      ]);
      if (generated.status !== 0) throw new Error(`openssl failed: ${String(generated.stderr)}`);
      server = createHttpsServer(
        { key: await readFile(keyFile), cert: await readFile(caFile) },
        (request, response) => {
          if (request.url?.startsWith('/git/')) {
            const [path] = request.url.split('?');
            serveGitOverHttp(fixtures, request, response, path!.slice('/git'.length));
            return;
          }
          requests.push({ host: request.headers.host, url: request.url });
          if (request.url?.startsWith('/moved/')) {
            response.writeHead(301, { Location: `https://${HOST}:${port}/owner/repo.git` });
          } else {
            response.writeHead(404);
          }
          response.end();
        },
      );
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(certDir, { recursive: true, force: true });
    });

    beforeEach(() => {
      requests = [];
    });

    const fixtureAdapter = (overrides: Partial<SystemGitSettings> = {}) =>
      adapter({
        allowedTransports: ['ssh', 'https'],
        httpsCaFile: caFile,
        resolveHost: async (host) => (host === HOST ? ['127.0.0.1'] : []),
        ...overrides,
      });

    it('connects to the checked address although the name resolves nowhere else', async () => {
      await expectReason(
        fixtureAdapter().inspectRemote(`https://${HOST}:${port}/owner/repo.git`, 'main'),
        'repository_not_found',
      );
      expect(requests).toEqual([
        { host: `${HOST}:${port}`, url: '/owner/repo.git/info/refs?service=git-upload-pack' },
      ]);
    });

    describe('memory bound (real git under prlimit, unbounded HTTP server)', () => {
      // One incompressible 60 MB blob: the local unpack must hold it in memory, which a 64 MiB
      // address space cannot do. The server is outside the bound, so the failure is the local
      // process's own, never a `remote:` line; the production bound (2 GiB) clones it fine.
      const BLOB = 60_000_000;
      const bounded = { maxCloneBytes: 500 * 1024 * 1024, maxProcessMemoryBytes: 64 * 1024 * 1024 };
      const heavyUrl = () => `https://${HOST}:${port}/git/heavy.git`;

      it('fails a clone that needs more memory than the bound with size_limit, and keeps no Clone', async () => {
        createFixture(fixtures, 'heavy', { 'blob.bin': randomBytes(BLOB) });
        await expectReason(
          fixtureAdapter(bounded).clone(PROJECT_ID, heavyUrl(), 'main'),
          'size_limit',
        );
        expect(await cloneEntries()).toEqual([]);
        expect(logs.some((line) => line.includes('ran out of memory'))).toBe(true);
      });

      it('removes the Clone when a fetch needs more memory than the bound', async () => {
        const fixture = createFixture(fixtures, 'heavy', { 'small.txt': 'small\n' });
        const git = fixtureAdapter(bounded);
        await git.clone(PROJECT_ID, heavyUrl(), 'main');
        addCommit(fixture, { 'blob.bin': randomBytes(BLOB) });
        await expectReason(git.fetch(PROJECT_ID, heavyUrl(), 'main'), 'size_limit');
        expect(await cloneEntries()).toEqual([]);
      });

      it('clones the same repository under the production bound', async () => {
        const fixture = createFixture(fixtures, 'heavy', { 'blob.bin': randomBytes(BLOB) });
        await expect(
          fixtureAdapter({
            maxCloneBytes: bounded.maxCloneBytes,
            maxProcessMemoryBytes: PRODUCTION_GIT_LIMITS.maxProcessMemoryBytes,
          }).clone(PROJECT_ID, heavyUrl(), 'main'),
        ).resolves.toEqual({ commit: headOf(fixture) });
      });
    });

    it('fails with redirect_refused and never follows the redirect', async () => {
      const error = await failureOf(
        fixtureAdapter().clone(PROJECT_ID, `https://${HOST}:${port}/moved/repo.git`, 'main'),
      );

      expect(error.reason).toBe('redirect_refused');
      expect(error.detail).toMatch(/returned error: 301/);
      expect(requests.map((request) => request.url)).toEqual([
        '/moved/repo.git/info/refs?service=git-upload-pack',
      ]);
      expect(await cloneEntries()).toEqual([]);
    });

    it('with the production default, refuses the loopback address before connecting', async () => {
      const error = await failureOf(
        fixtureAdapter({ allowPrivateRemotes: false }).inspectRemote(
          `https://${HOST}:${port}/owner/repo.git`,
          'main',
        ),
      );

      expect(error.reason).toBe('remote_not_allowed');
      expect(error.detail).toMatch(/STUDIO_GIT_ALLOW_PRIVATE_REMOTES=true/);
      expect(requests).toEqual([]);
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
