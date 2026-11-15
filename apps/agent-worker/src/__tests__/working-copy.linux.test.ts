import type { RunPayload } from '@agentic-studio/contracts';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_CHANGE_FILE, FakeRunner } from '../fake-runner.js';
import { GitRunner } from '../git.js';
import { drainRunStep } from '../runner.js';
import { UnsafeIdentifierError } from '../run-layout.js';
import { PreparationFailedError, STUDIO_EXCLUDE_SECTION, WorkingCopies } from '../working-copy.js';
import { createRemote, type FixtureRemote, git, isolatedGitEnv } from './fixtures/git-fixture.js';

// Issue #98: a Run's Working copy on the agent side, against fixture repositories reached
// through file:// remotes (no network). Linux only, like the worker; runs in CI on Linux.

const AGENT = { agentGitName: 'Studio Agent', agentGitEmail: 'agent@example.test' };

describe.skipIf(process.platform !== 'linux')('WorkingCopies', () => {
  let root: string;
  let dataDir: string;
  let home: string;
  let env: Record<string, string>;
  let remote: FixtureRemote;
  let first: string;
  let errors: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'studio-working-copy-'));
    dataDir = join(root, 'data');
    home = join(root, 'home');
    mkdirSync(home);
    env = isolatedGitEnv(home);
    remote = createRemote(root, 'shop', env);
    first = remote.commit('Initial commit', { 'README.md': '# Shop\n' });
    errors = [];
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A test worker: its fixture remotes are file:// URLs (allowed outside production only). */
  function workingCopies(allowFileRemotes = true) {
    return new WorkingCopies({
      dataDir,
      git: new GitRunner({ env: { PATH: env.PATH!, HOME: home } }),
      ...AGENT,
      allowFileRemotes,
      logger: { error: (message) => errors.push(message) },
    });
  }

  function payload(overrides: Partial<RunPayload> = {}): RunPayload {
    return {
      runId: randomUUID(),
      projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
      provider: 'claude_code',
      task: 'Add pagination',
      startCommit: first,
      repository: { remoteUrl: remote.url },
      limits: { stepMinutes: 60, maxSteps: 10 },
      completedSteps: 0,
      ...overrides,
    };
  }

  const signal = () => new AbortController().signal;
  const inRepo = (repoDir: string, args: string[]) => git(repoDir, args, env);
  const cacheDir = (projectId = payload().projectId) => join(dataDir, 'cache', `${projectId}.git`);

  it('builds the cache on the first Run and checks out the start commit on the Run branch', async () => {
    const run = payload();

    const prepared = await workingCopies().prepare(run, signal());

    expect(prepared.runDir).toBe(join(dataDir, 'runs', run.runId));
    expect(prepared.repoDir).toBe(join(prepared.runDir, 'repo'));
    expect(prepared.runBranch).toBe(`agent/add-pagination-r${run.runId.slice(0, 8)}`);
    expect(inRepo(prepared.repoDir, ['rev-parse', 'HEAD'])).toBe(first);
    expect(inRepo(prepared.repoDir, ['symbolic-ref', '--short', 'HEAD'])).toBe(prepared.runBranch);
    expect(inRepo(prepared.repoDir, ['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(prepared.repoDir, 'README.md'), 'utf8')).toBe('# Shop\n');
    expect(git(cacheDir(), ['rev-parse', 'refs/heads/main'], env)).toBe(first);
  });

  it("shares the cache's history on disk instead of copying it", async () => {
    const prepared = await workingCopies().prepare(payload(), signal());

    const objects = join(prepared.repoDir, '.git', 'objects');
    expect(existsSync(join(objects, 'info', 'alternates'))).toBe(false);
    const packs = readdirSync(join(objects, 'pack')).filter((name) => name.endsWith('.pack'));
    const looseDirs = readdirSync(objects).filter((name) => /^[0-9a-f]{2}$/.test(name));
    const sample = packs[0]
      ? join(objects, 'pack', packs[0])
      : join(objects, looseDirs[0]!, readdirSync(join(objects, looseDirs[0]!))[0]!);
    // Hardlinked from the cache: the same file on disk, linked at least twice.
    expect(statSync(sample).nlink).toBeGreaterThanOrEqual(2);
  });

  it("sets the Agent account's identity and the Project's remote, writing no credential", async () => {
    const prepared = await workingCopies().prepare(payload(), signal());

    expect(inRepo(prepared.repoDir, ['config', '--local', 'user.name'])).toBe('Studio Agent');
    expect(inRepo(prepared.repoDir, ['config', '--local', 'user.email'])).toBe(
      'agent@example.test',
    );
    expect(inRepo(prepared.repoDir, ['remote', 'get-url', 'origin'])).toBe(remote.url);
    expect(inRepo(prepared.repoDir, ['remote', 'get-url', '--push', 'origin'])).toBe(remote.url);
    const config = readFileSync(join(prepared.repoDir, '.git', 'config'), 'utf8');
    expect(config).not.toMatch(/credential|token|password|extraheader/i);
  });

  it('keeps the Task and the Run file beside the Working copy, outside the repository', async () => {
    const run = payload({ task: 'Add pagination to the list' });

    const prepared = await workingCopies().prepare(run, signal());

    expect(readFileSync(join(prepared.runDir, 'task.md'), 'utf8')).toBe(
      'Add pagination to the list\n',
    );
    expect(JSON.parse(readFileSync(join(prepared.runDir, 'run.json'), 'utf8'))).toEqual({
      runId: run.runId,
      projectId: run.projectId,
      runBranch: prepared.runBranch,
      startCommit: first,
      composeProjectName: `studio-run-${run.runId.replaceAll('-', '').slice(0, 12)}`,
    });
    expect(readdirSync(prepared.runDir).sort()).toEqual(['repo', 'run.json', 'task.md']);
    expect(prepared.env).toEqual({
      COMPOSE_PROJECT_NAME: `studio-run-${run.runId.replaceAll('-', '').slice(0, 12)}`,
    });
  });

  it('keeps a Studio section in .git/info/exclude, so files Studio places are never committed', async () => {
    const prepared = await workingCopies().prepare(payload(), signal());

    expect(readFileSync(join(prepared.repoDir, '.git', 'info', 'exclude'), 'utf8')).toContain(
      STUDIO_EXCLUDE_SECTION,
    );
  });

  it('reuses the cache for the next Run and picks up a new commit', async () => {
    const copies = workingCopies();
    await copies.prepare(payload(), signal());
    const marker = join(cacheDir(), 'studio-test-marker');
    writeFileSync(marker, 'kept');
    const second = remote.commit('Add pagination', { 'list.ts': 'export {};\n' });

    const prepared = await copies.prepare(payload({ startCommit: second }), signal());

    expect(existsSync(marker)).toBe(true);
    expect(inRepo(prepared.repoDir, ['rev-parse', 'HEAD'])).toBe(second);
    expect(existsSync(join(prepared.repoDir, 'list.ts'))).toBe(true);
  });

  it('checks out exactly the recorded commit, not the branch tip', async () => {
    remote.commit('Later work', { 'later.ts': 'export {};\n' });

    const prepared = await workingCopies().prepare(payload({ startCommit: first }), signal());

    expect(inRepo(prepared.repoDir, ['rev-parse', 'HEAD'])).toBe(first);
    expect(existsSync(join(prepared.repoDir, 'later.ts'))).toBe(false);
  });

  it('fails with a clear detail when the start commit is not in the remote', async () => {
    const missing = 'f'.repeat(40);

    const failure = await workingCopies()
      .prepare(payload({ startCommit: missing }), signal())
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PreparationFailedError);
    expect((failure as PreparationFailedError).detail).toBe(
      `The start commit ${missing} is not in the Project's repository; ` +
        'it may have been removed (e.g. by a force-push).',
    );
  });

  it('fails when the start commit was removed from the remote by a force-push', async () => {
    const gone = remote.commit('Soon gone', { 'gone.ts': 'export {};\n' });
    remote.forcePush(first);

    await expect(workingCopies().prepare(payload({ startCommit: gone }), signal())).rejects.toThrow(
      /is not in the Project's repository/,
    );
  });

  it('fails clearly when the remote cannot be fetched', async () => {
    const failure = await workingCopies()
      .prepare(payload({ repository: { remoteUrl: `file://${root}/missing.git` } }), signal())
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PreparationFailedError);
    expect((failure as PreparationFailedError).detail).toMatch(
      /^Preparing the Working copy failed while fetching the Project's repository/,
    );
    expect((failure as PreparationFailedError).detail).not.toContain(root);
  });

  it('keeps the cache when a refresh fails, failing only this Run', async () => {
    const copies = workingCopies();
    await copies.prepare(payload(), signal());
    const marker = join(cacheDir(), 'studio-test-marker');
    writeFileSync(marker, 'kept');
    const bare = remote.url.slice('file://'.length);
    renameSync(bare, `${bare}.away`);

    const failure = await copies.prepare(payload(), signal()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PreparationFailedError);
    expect((failure as PreparationFailedError).detail).toMatch(
      /while refreshing the Project's cache/,
    );
    expect(existsSync(marker)).toBe(true);
    renameSync(`${bare}.away`, bare);
  });

  it('discards and rebuilds a cache whose remote no longer matches the Project', async () => {
    const copies = workingCopies();
    await copies.prepare(payload(), signal());
    const marker = join(cacheDir(), 'studio-test-marker');
    writeFileSync(marker, 'stale');
    const moved = createRemote(root, 'shop-moved', env);
    const movedCommit = moved.commit('Moved', { 'MOVED.md': 'moved\n' });

    const prepared = await copies.prepare(
      payload({ startCommit: movedCommit, repository: { remoteUrl: moved.url } }),
      signal(),
    );

    expect(existsSync(marker)).toBe(false);
    expect(git(cacheDir(), ['config', '--get', 'remote.origin.url'], env)).toBe(moved.url);
    expect(inRepo(prepared.repoDir, ['rev-parse', 'HEAD'])).toBe(movedCommit);
  });

  it('gives Runs of the same Task their own, valid Run branches', async () => {
    const copies = workingCopies();
    const a = await copies.prepare(payload({ task: 'Fix: the LOGIN bug!' }), signal());
    const b = await copies.prepare(payload({ task: 'Fix: the LOGIN bug!' }), signal());

    expect(a.runBranch).not.toBe(b.runBranch);
    for (const branch of [a.runBranch, b.runBranch]) {
      expect(branch).toMatch(/^agent\/fix-the-login-bug-r[0-9a-f]{8}$/);
      expect(git(root, ['check-ref-format', '--branch', branch], env)).toBe(branch);
    }
  });

  it('refuses a local remote in a production worker, fetching nothing (coordinator decision 3)', async () => {
    for (const remoteUrl of [remote.url, remote.url.slice('file://'.length), '../shop.git']) {
      const failure = await workingCopies(false)
        .prepare(payload({ repository: { remoteUrl } }), signal())
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PreparationFailedError);
      expect((failure as PreparationFailedError).detail).toBe(
        "The Project's remote is a local path; only a development or test agent worker accepts one.",
      );
    }
    expect(existsSync(cacheDir())).toBe(false);
  });

  it('refuses the file transport for the remote in production even behind an https-looking URL', async () => {
    // The agent user's own Git configuration could rewrite an https URL to a local path; the
    // transport allow-list still refuses it.
    writeFileSync(
      join(home, '.gitconfig'),
      `[url "${remote.url}"]\n\tinsteadOf = https://git.example.test/acme/shop.git\n`,
    );

    await expect(
      workingCopies(false).prepare(
        payload({ repository: { remoteUrl: 'https://git.example.test/acme/shop.git' } }),
        signal(),
      ),
    ).rejects.toThrow(/fetching the Project's repository/);
  });

  it('refuses a runs directory that is a symlink (review of #117)', async () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(dataDir);
    symlinkSync(elsewhere, join(dataDir, 'runs'));

    await expect(workingCopies().prepare(payload(), signal())).rejects.toThrow(
      /not a real directory/,
    );
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a crafted identifier before touching anything', async () => {
    const outside = join(root, 'outside');

    for (const run of [
      payload({ runId: `../../outside` }),
      payload({ projectId: `../outside` }),
      payload({ runId: '/tmp/x' }),
    ]) {
      await expect(workingCopies().prepare(run, signal())).rejects.toBeInstanceOf(
        UnsafeIdentifierError,
      );
    }
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(dataDir)).toBe(false);
  });

  it('runs no hooks and writes nothing outside the Run directory for a hostile repository', async () => {
    // Outside the Run directory: a directory a symlink in the repository points at, and the
    // marker a hook would write.
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'untouched\n');
    const marker = join(root, 'hook-ran');
    const hooks = join(root, 'hooks');
    mkdirSync(join(hooks, 'hooks'), { recursive: true });
    for (const hook of [
      'post-checkout',
      'post-merge',
      'reference-transaction',
      'post-index-change',
    ]) {
      writeFileSync(join(hooks, 'hooks', hook), `#!/bin/sh\necho ${hook} >> ${marker}\n`);
      chmodSync(join(hooks, 'hooks', hook), 0o755);
    }
    const hostile = remote.commit(
      'Hostile content',
      {
        '.githooks/post-checkout': `#!/bin/sh\necho repo-hook >> ${marker}\n`,
        '.gitmodules': '[submodule "evil"]\n\tpath = evil\n\turl = ../evil.git\n',
      },
      { 'escape-dir': outside, 'escape-file': join(outside, 'secret.txt') },
    );
    // Hooks reach a fresh clone through the template directory, or apply through hooksPath.
    // (Written after the fixture's own commits, which would otherwise run them.)
    writeFileSync(
      join(home, '.gitconfig'),
      `[init]\n\ttemplateDir = ${hooks}\n[core]\n\thooksPath = ${join(hooks, 'hooks')}\n`,
    );
    mkdirSync(dataDir);
    const before = readdirSync(root).sort();

    const prepared = await workingCopies().prepare(payload({ startCommit: hostile }), signal());

    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(root).sort()).toEqual(before);
    expect(readdirSync(outside)).toEqual(['secret.txt']);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('untouched\n');
    // The symlinks are checked out as symlinks inside the Working copy, nothing more.
    expect(lstatSync(join(prepared.repoDir, 'escape-dir')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(prepared.repoDir, 'escape-file'))).toBe(join(outside, 'secret.txt'));
    expect(existsSync(join(prepared.repoDir, 'evil', '.git'))).toBe(false);
  });

  describe('result report', () => {
    async function runFake(task: string) {
      const copies = workingCopies();
      const prepared = await copies.prepare(payload({ task }), signal());
      await drainRunStep(
        new FakeRunner({ git: new GitRunner({ env: { PATH: env.PATH!, HOME: home } }) }).start({
          run: payload({ task }),
          workspace: { repoDir: prepared.repoDir, runDir: prepared.runDir, env: prepared.env },
          signal: signal(),
          processes: { register: () => undefined },
        }),
        () => undefined,
      );
      return { prepared, report: await copies.report(prepared, signal()) };
    }

    it('reports a Run that changed nothing', async () => {
      const { prepared, report } = await runFake('Add a feature');

      expect(report).toEqual({
        runBranch: prepared.runBranch,
        commits: [],
        hasUncommittedChanges: false,
      });
    });

    it('reports the commits on the Run branch since the start commit, made as the Agent account', async () => {
      const { prepared, report } = await runFake('[fake:commit] Add a feature');

      const head = inRepo(prepared.repoDir, ['rev-parse', 'HEAD']);
      expect(report).toEqual({
        runBranch: prepared.runBranch,
        commits: [{ id: head, subject: 'Fake change' }],
        hasUncommittedChanges: false,
      });
      expect(inRepo(prepared.repoDir, ['log', '-1', '--format=%an <%ae>'])).toBe(
        'Studio Agent <agent@example.test>',
      );
    });

    it('reports uncommitted changes left behind', async () => {
      const { report } = await runFake('[fake:dirty] Add a feature');

      expect(report).toMatchObject({ commits: [], hasUncommittedChanges: true });
    });

    it('never writes through a symlink the repository puts at the fake change (review of #117)', async () => {
      const outside = join(root, 'outside.txt');
      writeFileSync(outside, 'untouched');
      const hostile = remote.commit('Link', {}, { [FAKE_CHANGE_FILE]: outside });
      const copies = workingCopies();
      const run = payload({ task: '[fake:dirty]', startCommit: hostile });
      const prepared = await copies.prepare(run, signal());

      await drainRunStep(
        new FakeRunner({ git: new GitRunner({ env: { PATH: env.PATH!, HOME: home } }) }).start({
          run,
          workspace: { repoDir: prepared.repoDir, runDir: prepared.runDir, env: prepared.env },
          signal: signal(),
          processes: { register: () => undefined },
        }),
        () => undefined,
      );

      expect(readFileSync(outside, 'utf8')).toBe('untouched');
      expect(lstatSync(join(prepared.repoDir, FAKE_CHANGE_FILE)).isFile()).toBe(true);
    });

    it('lists commits oldest first and shortens long subjects', async () => {
      const copies = workingCopies();
      const prepared = await copies.prepare(payload(), signal());
      const long = `${'s'.repeat(250)}`;
      for (const subject of ['First', 'Second', long]) {
        writeFileSync(join(prepared.repoDir, `${subject.slice(0, 10)}.txt`), subject);
        inRepo(prepared.repoDir, ['add', '--all']);
        inRepo(prepared.repoDir, ['commit', '--quiet', '-m', subject]);
      }

      const report = await copies.report(prepared, signal());

      expect(report.commits.map((commit) => commit.subject)).toEqual([
        'First',
        'Second',
        's'.repeat(200),
      ]);
    });

    it('never counts a file Studio excludes as an uncommitted change', async () => {
      const copies = workingCopies();
      const prepared = await copies.prepare(payload(), signal());
      writeFileSync(
        join(prepared.repoDir, '.git', 'info', 'exclude'),
        `${readFileSync(join(prepared.repoDir, '.git', 'info', 'exclude'), 'utf8')}.studio.env\n`,
      );
      writeFileSync(join(prepared.repoDir, '.studio.env'), 'PLACED=by-studio\n');

      expect((await copies.report(prepared, signal())).hasUncommittedChanges).toBe(false);
      expect(FAKE_CHANGE_FILE).toBe('FAKE_CHANGE.md');
    });
  });
});
