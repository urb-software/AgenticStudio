import type { RunPayload, RunStepResult } from '@agentic-studio/contracts';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Deliveries } from '../delivery.js';
import { GitRunner } from '../git.js';
import { RestoreFailedError, restoreNotice, ReviewGuard } from '../review-guard.js';
import { type PreparedRun, WorkingCopies } from '../working-copy.js';
import { createRemote, type FixtureRemote, git, isolatedGitEnv } from './fixtures/git-fixture.js';
import { type StubGitHub, startStubGitHub } from './fixtures/stub-github.js';
import { agentFields } from './agent-fixtures.js';

// A review Phase may read the Working copy and change nothing: what it edits, adds, deletes or
// commits is put back, and never reaches a commit or a push. Real Git on fixture repositories.

const AGENT = { agentGitName: 'Studio Agent', agentGitEmail: 'agent@example.test' };
const WORK_RESULT: RunStepResult = {
  outcome: 'done',
  summary: 'Add pagination to the product list',
  pullRequest: { title: 'Add pagination', body: 'Pages of 20 products.' },
};

describe.skipIf(process.platform !== 'linux')('a review Phase and the Working copy', () => {
  let root: string;
  let dataDir: string;
  let home: string;
  let env: Record<string, string>;
  let remote: FixtureRemote;
  let first: string;
  let stub: StubGitHub;
  let logs: string[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'studio-review-'));
    dataDir = join(root, 'data');
    home = join(root, 'home');
    mkdirSync(home);
    env = isolatedGitEnv(home);
    remote = createRemote(join(root, 'acme'), 'shop', env);
    first = remote.commit('Initial commit', {
      'README.md': '# Shop\n',
      'src/app.ts': 'export const a = 1;\n',
      'src/old.ts': 'export const old = true;\n',
      '.gitignore': 'ignored/\n',
    });
    stub = await startStubGitHub();
    logs = [];
  });

  afterEach(async () => {
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  const logger = { error: (message: string) => logs.push(message) };
  const runner = () => new GitRunner({ env: { PATH: env.PATH!, HOME: home } });
  const signal = () => new AbortController().signal;
  const bare = () => join(root, 'acme', 'shop.git');

  function payload(provider: 'claude_code' | 'codex'): RunPayload {
    return {
      runId: randomUUID(),
      projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
      provider,
      ...agentFields(provider),
      task: 'Add pagination',
      startCommit: first,
      repository: { remoteUrl: remote.url },
      integrationBranch: 'main',
      kind: 'next_phase',
      phase: { position: 1, itemId: 'check', count: 2, final: true, kind: 'review' },
      studioPaths: [],
      limits: { stepMinutes: 60, maxSteps: 10 },
      completedSteps: 1,
    };
  }

  async function prepare(run: RunPayload): Promise<PreparedRun> {
    return new WorkingCopies({
      dataDir,
      git: runner(),
      ...AGENT,
      allowFileRemotes: true,
      logger,
    }).prepare(run, signal());
  }

  const inRepo = (prepared: PreparedRun, args: string[]) => git(prepared.repoDir, args, env);
  const write = (prepared: PreparedRun, path: string, content: string) => {
    mkdirSync(join(prepared.repoDir, path, '..'), { recursive: true });
    writeFileSync(join(prepared.repoDir, path), content);
  };
  const read = (prepared: PreparedRun, path: string) =>
    readFileSync(join(prepared.repoDir, path), 'utf8');

  /** What the Phase before the review left: a commit, an uncommitted edit and an untracked file. */
  function workLeaves(prepared: PreparedRun) {
    write(prepared, 'src/pages.ts', 'export const PAGE = 20;\n');
    inRepo(prepared, ['add', '--all']);
    inRepo(prepared, ['commit', '--quiet', '-m', 'Add pagination']);
    write(prepared, 'README.md', '# Shop\n\nPaginated.\n');
    write(prepared, 'notes.txt', 'Left untracked by the work.\n');
    write(prepared, 'ignored/cache.bin', 'ignored build output\n');
  }

  /** What a careless review does with the Working copy and Git. */
  function carelessReview(prepared: PreparedRun) {
    write(prepared, 'README.md', 'Rewritten by the review.\n');
    write(prepared, 'src/review.ts', 'export const REVIEWED = true;\n');
    write(prepared, 'notes.txt', 'Edited by the review.\n');
    rmSync(join(prepared.repoDir, 'src/old.ts'));
    inRepo(prepared, ['add', '--all']);
    inRepo(prepared, ['commit', '--quiet', '-m', 'Review edit']);
    write(prepared, 'src/leftover.ts', 'export const LEFT = true;\n');
    inRepo(prepared, ['checkout', '--quiet', '-b', 'review-side-branch']);
    write(prepared, 'src/second.ts', 'export const SECOND = true;\n');
    inRepo(prepared, ['add', '--all']);
    inRepo(prepared, ['commit', '--quiet', '-m', 'Review edit on another branch']);
    write(prepared, 'src/third.ts', 'staged only\n');
    inRepo(prepared, ['add', 'src/third.ts']);
  }

  /** Everything the guard promises to put back, as a comparable value. */
  function stateOf(prepared: PreparedRun) {
    return {
      head: inRepo(prepared, ['rev-parse', 'HEAD']),
      branch: inRepo(prepared, ['symbolic-ref', 'HEAD']),
      status: inRepo(prepared, ['status', '--porcelain=v1', '--untracked-files=all']),
      readme: read(prepared, 'README.md'),
      notes: read(prepared, 'notes.txt'),
      old: existsSync(join(prepared.repoDir, 'src/old.ts')),
      ignored: read(prepared, 'ignored/cache.bin'),
      staged: inRepo(prepared, ['diff', '--cached', '--name-status']),
    };
  }

  const remoteTree = (branch: string) =>
    git(bare(), ['ls-tree', '-r', '--name-only', `refs/heads/${branch}`], env).split('\n');

  it.each(['claude_code', 'codex'] as const)(
    'restores what a %s review edited, added, deleted and committed, so none of it is committed or pushed',
    async (provider) => {
      const run = payload(provider);
      const prepared = await prepare(run);
      workLeaves(prepared);
      const before = stateOf(prepared);
      const guard = new ReviewGuard(runner());

      const snapshot = await guard.capture(prepared);
      carelessReview(prepared);
      const report = await guard.restore(snapshot);

      expect(report.restored).toBe(true);
      expect(report.headMoved).toBe(true);
      expect(stateOf(prepared)).toEqual(before);
      expect(existsSync(join(prepared.repoDir, 'src/review.ts'))).toBe(false);
      expect(existsSync(join(prepared.repoDir, 'src/leftover.ts'))).toBe(false);
      expect(restoreNotice(report)).toMatch(/^The review Phase changed the working copy/);

      // The delivery after the review commits what the work left, and nothing of the review.
      const deliveries = new Deliveries({
        dataDir,
        git: runner(),
        ...AGENT,
        allowFileRemotes: true,
        github: { apiUrl: stub.url, token: 'ghp_not-a-real-token-for-the-stub' },
        logger,
      });
      await deliveries.commit(prepared, run, WORK_RESULT, signal());
      const delivery = await deliveries.deliver(prepared, run, WORK_RESULT, signal());

      expect(delivery.outcome).toBe('delivered');
      const files = remoteTree(prepared.runBranch);
      expect(files).toEqual(
        expect.arrayContaining(['src/pages.ts', 'src/old.ts', 'notes.txt', 'README.md']),
      );
      for (const never of ['src/review.ts', 'src/leftover.ts', 'src/second.ts', 'src/third.ts']) {
        expect(files).not.toContain(never);
      }
      const pushed = (path: string) =>
        git(bare(), ['show', `refs/heads/${prepared.runBranch}:${path}`], env);
      expect(pushed('README.md')).toBe('# Shop\n\nPaginated.');
      expect(pushed('notes.txt')).toBe('Left untracked by the work.');
      const log = git(bare(), ['log', '--format=%s', `refs/heads/${prepared.runBranch}`], env);
      expect(log).not.toContain('Review edit');
      expect(
        git(bare(), ['for-each-ref', '--format=%(refname)', 'refs/heads/'], env),
      ).not.toContain('review-side-branch');
    },
  );

  it('says nothing was restored when the review changed nothing, and leaves the index alone', async () => {
    const prepared = await prepare(payload('codex'));
    workLeaves(prepared);
    inRepo(prepared, ['add', 'notes.txt']);
    const before = stateOf(prepared);
    const guard = new ReviewGuard(runner());

    const snapshot = await guard.capture(prepared);
    // Recording the state does not touch the real index.
    expect(stateOf(prepared)).toEqual(before);
    const report = await guard.restore(snapshot);

    expect(report).toEqual({ restored: false, headMoved: false, added: 0, changed: 0 });
    expect(restoreNotice(report)).toBeNull();
    expect(stateOf(prepared)).toEqual(before);
  });

  it('puts a detached HEAD back, and a file replaced by a directory', async () => {
    const prepared = await prepare(payload('claude_code'));
    workLeaves(prepared);
    inRepo(prepared, ['checkout', '--quiet', '--detach']);
    const before = inRepo(prepared, ['rev-parse', 'HEAD']);
    const guard = new ReviewGuard(runner());

    const snapshot = await guard.capture(prepared);
    rmSync(join(prepared.repoDir, 'notes.txt'));
    write(prepared, 'notes.txt/inner.txt', 'a directory where a file was\n');
    inRepo(prepared, ['checkout', '--quiet', '-B', 'moved']);
    await guard.restore(snapshot);

    expect(inRepo(prepared, ['rev-parse', 'HEAD'])).toBe(before);
    expect(() => inRepo(prepared, ['symbolic-ref', '--quiet', 'HEAD'])).toThrow();
    expect(read(prepared, 'notes.txt')).toBe('Left untracked by the work.\n');
    expect(existsSync(join(prepared.repoDir, 'notes.txt/inner.txt'))).toBe(false);
  });

  it('never writes through a symlink the review put where a directory was', async () => {
    const prepared = await prepare(payload('codex'));
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'victim.txt'), 'keep\n');
    const guard = new ReviewGuard(runner());

    const snapshot = await guard.capture(prepared);
    symlinkSync(outside, join(prepared.repoDir, 'linked'));
    await guard.restore(snapshot);

    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('keep\n');
    expect(existsSync(join(prepared.repoDir, 'linked'))).toBe(false);
  });

  it('fails when the Working copy cannot be put back', async () => {
    const prepared = await prepare(payload('codex'));
    const guard = new ReviewGuard(runner());
    const snapshot = await guard.capture(prepared);
    write(prepared, 'src/review.ts', 'added\n');

    await expect(guard.restore({ ...snapshot, headCommit: 'f'.repeat(40) })).rejects.toBeInstanceOf(
      RestoreFailedError,
    );
  });

  it('is not given a hook of the Working copy to run: every Git command has hooks off', async () => {
    const run = payload('claude_code');
    const prepared = await prepare(run);
    const marker = join(root, 'hook-ran');
    write(prepared, '.git/hooks/pre-commit', `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(prepared.repoDir, '.git/hooks/pre-commit'), 0o755);
    inRepo(prepared, ['config', 'core.hooksPath', '.git/hooks']);
    const guard = new ReviewGuard(runner());
    const snapshot = await guard.capture(prepared);
    write(prepared, 'src/review.ts', 'added\n');
    await guard.restore(snapshot);
    const deliveries = new Deliveries({
      dataDir,
      git: runner(),
      ...AGENT,
      allowFileRemotes: true,
      github: { apiUrl: stub.url, token: 'ghp_not-a-real-token-for-the-stub' },
      logger,
    });
    write(prepared, 'src/work.ts', 'x\n');

    await deliveries.commit(prepared, run, WORK_RESULT, signal());

    expect(inRepo(prepared, ['log', '-1', '--format=%s'])).toMatch(/Add pagination/);
    expect(existsSync(marker)).toBe(false);
  });
});
