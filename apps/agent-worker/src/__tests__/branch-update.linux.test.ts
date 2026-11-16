import type { RunPayload, RunStepResult } from '@agentic-studio/contracts';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BranchUpdates, MergeIncompleteError } from '../branch-update.js';
import { Deliveries } from '../delivery.js';
import { type GitOptions, GitRunner } from '../git.js';
import { PreparationFailedError, type PreparedRun, WorkingCopies } from '../working-copy.js';
import { createRemote, type FixtureRemote, git, isolatedGitEnv } from './fixtures/git-fixture.js';
import { type StubGitHub, startStubGitHub } from './fixtures/stub-github.js';

// Issue #147: bringing a Run branch up to date, on a real Working copy and a fixture remote
// (file://, no network). Linux only, like the worker; runs in CI on Linux.

const AGENT = { agentGitName: 'Studio Agent', agentGitEmail: 'agent@example.test' };
const DONE: RunStepResult = {
  outcome: 'done',
  summary: 'Brought the branch up to date.',
  checks: [{ name: 'unit tests', result: 'passed' }],
};

/** Records every Git command, so the push can be inspected. */
class RecordingGit extends GitRunner {
  readonly calls: { args: readonly string[]; options: GitOptions }[] = [];
  override run(args: readonly string[], options: GitOptions): Promise<string> {
    this.calls.push({ args, options });
    return super.run(args, options);
  }
}

describe.skipIf(process.platform !== 'linux')('BranchUpdates', () => {
  let root: string;
  let dataDir: string;
  let home: string;
  let env: Record<string, string>;
  let remote: FixtureRemote;
  let first: string;
  let stub: StubGitHub;
  let gitRunner: RecordingGit;
  let logs: string[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'studio-branch-update-'));
    dataDir = join(root, 'data');
    home = join(root, 'home');
    mkdirSync(home);
    env = isolatedGitEnv(home);
    // Under acme/: a development or test worker names a file:// remote by its last two parts.
    remote = createRemote(join(root, 'acme'), 'shop', env);
    first = remote.commit('Initial commit', { 'README.md': '# Shop\n', 'config.txt': 'a=1\n' });
    stub = await startStubGitHub();
    gitRunner = new RecordingGit({ env: { PATH: env.PATH!, HOME: home } });
    logs = [];
  });

  afterEach(async () => {
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  const logger = { error: (message: string) => logs.push(message) };
  const signal = () => new AbortController().signal;

  const workingCopies = () =>
    new WorkingCopies({ dataDir, git: gitRunner, ...AGENT, allowFileRemotes: true, logger });
  const updates = () =>
    new BranchUpdates({
      dataDir,
      git: gitRunner,
      workingCopies: workingCopies(),
      ...AGENT,
      logger,
    });
  const deliveries = () =>
    new Deliveries({
      dataDir,
      git: gitRunner,
      ...AGENT,
      allowFileRemotes: true,
      github: { apiUrl: stub.url, token: 'test-only-token' },
      logger,
    });

  function payload(overrides: Partial<RunPayload> = {}): RunPayload {
    return {
      runId: randomUUID(),
      projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
      provider: 'claude_code',
      task: 'Add pagination',
      startCommit: first,
      repository: { remoteUrl: remote.url },
      integrationBranch: 'main',
      kind: 'start',
      studioPaths: [],
      limits: { stepMinutes: 60, maxSteps: 10 },
      completedSteps: 0,
      ...overrides,
    };
  }

  const prepare = (run: RunPayload): Promise<PreparedRun> => workingCopies().prepare(run, signal());
  const inRepo = (prepared: PreparedRun, args: string[]) => git(prepared.repoDir, args, env);
  const headOf = (prepared: PreparedRun) => inRepo(prepared, ['rev-parse', 'HEAD']);
  const parentsOf = (prepared: PreparedRun, rev = 'HEAD') =>
    inRepo(prepared, ['rev-list', '--parents', '-n', '1', rev]).split(' ').slice(1);
  const mergeOpen = (prepared: PreparedRun) =>
    existsSync(join(prepared.repoDir, '.git', 'MERGE_HEAD'));
  const bare = () => join(root, 'acme', 'shop.git');

  function agentCommits(prepared: PreparedRun, files: Record<string, string>, message: string) {
    for (const [path, content] of Object.entries(files)) {
      writeFileSync(join(prepared.repoDir, path), content);
    }
    inRepo(prepared, ['add', '--all']);
    inRepo(prepared, ['commit', '--quiet', '-m', message]);
  }

  /** A Run branch with one commit of its own, behind the integration branch by `remoteFiles`. */
  async function behind(remoteFiles: Record<string, string>, runFiles: Record<string, string>) {
    const run = payload();
    const prepared = await prepare(run);
    agentCommits(prepared, runFiles, 'Run change');
    const tip = remote.commit('Integration change', remoteFiles);
    return { run, prepared, tip };
  }

  it('merges the integration branch with a merge commit that keeps both histories, no rebase', async () => {
    const { run, prepared, tip } = await behind({ 'main.txt': 'x\n' }, { 'run.txt': 'y\n' });
    const before = headOf(prepared);

    const start = await updates().start(prepared, run, signal());

    expect(start).toEqual({ outcome: 'merged', commit: tip, baseCommit: before });
    // A merge commit: the Run branch's own tip first, the integration commit second.
    expect(parentsOf(prepared)).toEqual([before, tip]);
    expect(inRepo(prepared, ['log', '-1', '--format=%s'])).toBe(
      'Merge main into ' + prepared.runBranch,
    );
    expect(inRepo(prepared, ['log', '-1', '--format=%ae'])).toBe(AGENT.agentGitEmail);
    expect(readFileSync(join(prepared.repoDir, 'main.txt'), 'utf8')).toBe('x\n');
    expect(readFileSync(join(prepared.repoDir, 'run.txt'), 'utf8')).toBe('y\n');
    expect(mergeOpen(prepared)).toBe(false);
    // The helper ref does not stay in the Working copy.
    expect(inRepo(prepared, ['for-each-ref', 'refs/studio/'])).toBe('');
    // Nothing was pushed: the remote knows no Run branch.
    expect(git(bare(), ['for-each-ref', '--format=%(refname)', 'refs/heads/'], env)).toBe(
      'refs/heads/main',
    );
  });

  it('commits what the agent left uncommitted first, as the Agent account, never a Studio file', async () => {
    const run = payload({
      studioPaths: ['.env'],
      environmentFile: { path: '.env', content: 'SECRET=1\n' },
    });
    const prepared = await prepare(run);
    writeFileSync(join(prepared.repoDir, 'wip.ts'), 'export const WIP = 1;\n');
    const tip = remote.commit('Integration change', { 'main.txt': 'x\n' });

    const start = await updates().start(prepared, run, signal());

    const [own] = parentsOf(prepared);
    // The base is the Run branch's commit after the leftovers were committed.
    expect(start).toEqual({ outcome: 'merged', commit: tip, baseCommit: own });
    expect(inRepo(prepared, ['show', '--format=%an <%ae>', '--no-patch', own!])).toBe(
      `${AGENT.agentGitName} <${AGENT.agentGitEmail}>`,
    );
    expect(inRepo(prepared, ['ls-files'])).toContain('wip.ts');
    expect(inRepo(prepared, ['ls-files'])).not.toContain('.env');
    expect(readFileSync(join(prepared.repoDir, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(inRepo(prepared, ['status', '--porcelain'])).toBe('');
  });

  it('changes nothing when the Run branch already has the integration branch, not even a commit', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentCommits(prepared, { 'run.txt': 'y\n' }, 'Run change');
    const before = headOf(prepared);
    // Review S9 of #154: what is uncommitted stays exactly as it is.
    writeFileSync(join(prepared.repoDir, 'wip.ts'), 'export const WIP = 1;\n');

    const start = await updates().start(prepared, run, signal());

    expect(start).toEqual({ outcome: 'already_up_to_date', commit: first });
    expect(headOf(prepared)).toBe(before);
    expect(inRepo(prepared, ['status', '--porcelain'])).toBe('?? wip.ts');
    expect(mergeOpen(prepared)).toBe(false);
  });

  it('is also up to date once an earlier request merged everything', async () => {
    const { run, prepared } = await behind({ 'main.txt': 'x\n' }, { 'run.txt': 'y\n' });
    await updates().start(prepared, run, signal());
    const merged = headOf(prepared);

    expect((await updates().start(prepared, run, signal())).outcome).toBe('already_up_to_date');
    expect(headOf(prepared)).toBe(merged);
  });

  it('fails as preparation_failed, merging nothing, when the integration branch cannot be fetched', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentCommits(prepared, { 'run.txt': 'y\n' }, 'Run change');
    const before = headOf(prepared);
    rmSync(bare(), { recursive: true, force: true });

    await expect(updates().start(prepared, run, signal())).rejects.toBeInstanceOf(
      PreparationFailedError,
    );
    expect(headOf(prepared)).toBe(before);
    expect(mergeOpen(prepared)).toBe(false);
  });

  it('fails as preparation_failed for an integration branch the remote does not have', async () => {
    const run = payload({ integrationBranch: 'no-such-branch' });
    const prepared = await prepare(payload());

    await expect(updates().start(prepared, run, signal())).rejects.toThrow(/could not be fetched/);
  });

  it('refuses an integration branch name that is not a branch name', async () => {
    const prepared = await prepare(payload());
    for (const name of ['--upload-pack=x', 'a..b', 'x y']) {
      await expect(
        updates().start(prepared, payload({ integrationBranch: name }), signal()),
      ).rejects.toBeInstanceOf(PreparationFailedError);
    }
  });

  describe('with conflicts', () => {
    async function conflicted() {
      const setup = await behind({ 'config.txt': 'a=main\n' }, { 'config.txt': 'a=run\n' });
      const start = await updates().start(setup.prepared, setup.run, signal());
      return { ...setup, start };
    }

    it('leaves the merge open and lists the conflicted files', async () => {
      const { prepared, start, tip } = await conflicted();

      expect(start).toEqual({
        outcome: 'conflicts',
        commit: tip,
        baseCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
        files: ['config.txt'],
        moreFiles: 0,
      });
      expect(mergeOpen(prepared)).toBe(true);
      expect(readFileSync(join(prepared.repoDir, 'config.txt'), 'utf8')).toContain('<<<<<<<');
    });

    it('completes the merge commit once the agent resolved and staged the files', async () => {
      const { run, prepared, tip } = await conflicted();
      const before = headOf(prepared);
      writeFileSync(join(prepared.repoDir, 'config.txt'), 'a=both\n');
      inRepo(prepared, ['add', 'config.txt']);

      const completed = await updates().complete(prepared, run, signal());

      expect(completed).toEqual({ mergedCommit: tip, completed: true });
      expect(parentsOf(prepared)).toEqual([before, tip]);
      expect(mergeOpen(prepared)).toBe(false);
      expect(inRepo(prepared, ['log', '-1', '--format=%ae'])).toBe(AGENT.agentGitEmail);
    });

    it('knows the merge is done when the agent completed it itself, and fails when it aborted it', async () => {
      const { run, prepared, tip } = await conflicted();
      writeFileSync(join(prepared.repoDir, 'config.txt'), 'a=both\n');
      inRepo(prepared, ['add', 'config.txt']);
      inRepo(prepared, ['commit', '--quiet', '--no-edit']);

      // No merge is open any more and the commit is in the history: done, nothing more to commit.
      expect(await updates().complete(prepared, run, signal(), tip)).toEqual({
        mergedCommit: tip,
        completed: false,
      });
      expect(parentsOf(prepared)[1]).toBe(tip);

      // Another Working copy, where the agent aborted the merge instead.
      const other = payload();
      const second = await prepare(other);
      agentCommits(second, { 'config.txt': 'a=run\n' }, 'Run change');
      const newTip = remote.commit('Another integration change', { 'config.txt': 'a=main2\n' });
      await updates().start(second, other, signal());
      inRepo(second, ['merge', '--abort']);
      await expect(updates().complete(second, other, signal(), newTip)).rejects.toBeInstanceOf(
        MergeIncompleteError,
      );
      // Without an expected commit there is nothing to check.
      expect(await updates().complete(second, other, signal())).toBeNull();
    });

    it('stages and completes what the agent resolved in the tree but could not stage', async () => {
      const { run, prepared, tip } = await conflicted();
      writeFileSync(join(prepared.repoDir, 'config.txt'), 'a=both\n');

      expect(await updates().complete(prepared, run, signal())).toEqual({
        mergedCommit: tip,
        completed: true,
      });
      expect(readFileSync(join(prepared.repoDir, 'config.txt'), 'utf8')).toBe('a=both\n');
      expect(parentsOf(prepared)).toHaveLength(2);
      expect(inRepo(prepared, ['status', '--porcelain'])).toBe('');
    });

    it('accepts a file the agent resolved by deleting it', async () => {
      const { run, prepared } = await conflicted();
      unlinkSync(join(prepared.repoDir, 'config.txt'));

      await updates().complete(prepared, run, signal());

      expect(parentsOf(prepared)).toHaveLength(2);
      expect(existsSync(join(prepared.repoDir, 'config.txt'))).toBe(false);
    });

    it('refuses a file that still has conflict markers, then aborts to the state before', async () => {
      const { run, prepared } = await conflicted();
      const before = headOf(prepared);

      await expect(updates().complete(prepared, run, signal())).rejects.toBeInstanceOf(
        MergeIncompleteError,
      );
      expect(mergeOpen(prepared)).toBe(true);

      expect(await updates().abort(prepared)).toBe(true);
      expect(mergeOpen(prepared)).toBe(false);
      expect(headOf(prepared)).toBe(before);
      expect(readFileSync(join(prepared.repoDir, 'config.txt'), 'utf8')).toBe('a=run\n');
      expect(inRepo(prepared, ['status', '--porcelain'])).toBe('');
    });

    it('does not commit a Studio file the agent staged by force into the merge', async () => {
      const run = payload({
        studioPaths: ['.env'],
        environmentFile: { path: '.env', content: 'SECRET=1\n' },
      });
      const prepared = await prepare(run);
      agentCommits(prepared, { 'config.txt': 'a=run\n' }, 'Run change');
      remote.commit('Integration change', { 'config.txt': 'a=main\n' });
      await updates().start(prepared, run, signal());
      writeFileSync(join(prepared.repoDir, 'config.txt'), 'a=both\n');
      inRepo(prepared, ['add', 'config.txt']);
      inRepo(prepared, ['add', '--force', '.env']);

      await updates().complete(prepared, run, signal());

      expect(inRepo(prepared, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain('.env');
    });

    it('completes nothing, and aborts nothing, when no merge is open', async () => {
      const run = payload();
      const prepared = await prepare(run);

      expect(await updates().complete(prepared, run, signal())).toBeNull();
      expect(await updates().abort(prepared)).toBe(false);
    });

    it('does not start on a Working copy with a merge already open', async () => {
      const { run, prepared } = await conflicted();

      await expect(updates().start(prepared, run, signal())).rejects.toThrow(/already open/);
      expect(mergeOpen(prepared)).toBe(true);
    });
  });

  describe('conflicts that are not text (review S5 of #154)', () => {
    /** A binary file both sides added: git leaves "ours" in the tree, without a marker. */
    async function binaryConflict() {
      const run = payload();
      const prepared = await prepare(run);
      agentCommits(prepared, { 'logo.bin': '\u0000ours\n' }, 'Add the logo');
      remote.commit('Their logo', { 'logo.bin': '\u0000theirs\n' });
      const start = await updates().start(prepared, run, signal());
      return { run, prepared, start };
    }

    it('does not take a binary conflict the agent left alone: the merge is refused, then aborted', async () => {
      const { run, prepared, start } = await binaryConflict();
      // Both sides added logo.bin differently: a conflict without a marker.
      expect(start.outcome).toBe('conflicts');
      expect(readFileSync(join(prepared.repoDir, 'logo.bin'), 'utf8')).toBe('\u0000ours\n');
      const before = parentsOf(prepared);

      await expect(updates().complete(prepared, run, signal())).rejects.toThrow(/logo\.bin/);
      expect(mergeOpen(prepared)).toBe(true);

      expect(await updates().abort(prepared)).toBe(true);
      expect(mergeOpen(prepared)).toBe(false);
      expect(parentsOf(prepared)).toEqual(before);
    });

    it('takes the binary file once the agent staged its own choice', async () => {
      const { run, prepared } = await binaryConflict();
      writeFileSync(join(prepared.repoDir, 'logo.bin'), '\u0000mine\n');
      inRepo(prepared, ['add', 'logo.bin']);

      expect((await updates().complete(prepared, run, signal()))?.completed).toBe(true);
      expect(parentsOf(prepared)).toHaveLength(2);
    });
  });

  describe('undoing an update that did not end well (review S3 of #154)', () => {
    it('resets the Run branch to the commit before the merge, so a second request merges again', async () => {
      const { run, prepared } = await behind({ 'main.txt': 'x\n' }, { 'run.txt': 'y\n' });
      const start = await updates().start(prepared, run, signal());
      if (start.outcome !== 'merged') throw new Error('expected a clean merge');
      // The agent then made a fix of its own.
      agentCommits(prepared, { 'fix.ts': 'fix\n' }, 'Fix what the update broke');

      expect(await updates().abort(prepared, start.baseCommit)).toBe(true);

      expect(headOf(prepared)).toBe(start.baseCommit);
      expect(existsSync(join(prepared.repoDir, 'main.txt'))).toBe(false);
      // The next request is not "already up to date": it merges the integration branch again.
      expect((await updates().start(prepared, run, signal())).outcome).toBe('merged');
    });

    it('also takes an open merge with it, and leaves a branch that is already at the base alone', async () => {
      const { run, prepared } = await behind(
        { 'config.txt': 'a=main\n' },
        { 'config.txt': 'a=run\n' },
      );
      const start = await updates().start(prepared, run, signal());
      if (start.outcome !== 'conflicts') throw new Error('expected conflicts');

      expect(await updates().abort(prepared, start.baseCommit)).toBe(true);
      expect(mergeOpen(prepared)).toBe(false);
      expect(headOf(prepared)).toBe(start.baseCommit);
      expect(await updates().abort(prepared, start.baseCommit)).toBe(false);
    });

    it('never resets to a commit the Run branch does not contain', async () => {
      const { run, prepared } = await behind({ 'main.txt': 'x\n' }, { 'run.txt': 'y\n' });
      const head = headOf(prepared);

      expect(await updates().abort(prepared, 'f'.repeat(40))).toBe(false);
      expect(headOf(prepared)).toBe(head);
      void run;
    });
  });

  describe('the Run own changes after a merge (review S1 of #154)', () => {
    it('counts the Run commits from the merged integration commit, not from the start commit', async () => {
      const { run, prepared, tip } = await behind({ 'main.txt': 'x\n' }, { 'run.txt': 'y\n' });
      await updates().start(prepared, run, signal());
      const report = (base: string) =>
        workingCopies().report({ ...prepared, diffBase: base }, signal());

      const fromStart = await report(first);
      const fromMerge = await report(tip);

      // From the start commit, the integration commit shows as the Run's own work.
      expect(fromStart.commits.map((commit) => commit.subject)).toContain('Integration change');
      // From the merged commit: the Run's commit and the merge, as the pull request shows them.
      expect(fromMerge.commits.map((commit) => commit.subject)).toEqual([
        'Run change',
        `Merge main into ${prepared.runBranch}`,
      ]);
    });
  });

  describe('delivery after the update', () => {
    const resume = (run: RunPayload, prepared: PreparedRun): RunPayload => ({
      ...run,
      kind: 'resume',
      runBranch: prepared.runBranch,
      sessionRef: 'session-1',
      answer: 'Bring the Run branch up to date.',
      resumeReason: 'bring_up_to_date',
      followUpNumber: 1,
      bringUpToDate: true,
      nextSeq: 10,
      completedSteps: 1,
      stepsBeforePart: 1,
      pullRequestNumber: 1,
    });

    it('pushes the merge as an ordinary fast-forward of the Run branch: no rebase, no force', async () => {
      const run = payload();
      const prepared = await prepare(run);
      agentCommits(prepared, { 'run.txt': 'y\n' }, 'Run change');
      const delivery = deliveries();
      await delivery.commit(prepared, run, DONE, signal());
      const firstDelivery = await delivery.deliver(prepared, run, DONE, signal());
      expect(firstDelivery.outcome).toBe('delivered');
      const pushedBefore = headOf(prepared);
      const tip = remote.commit('Integration change', { 'main.txt': 'x\n' });

      const followUp = resume(run, prepared);
      expect((await updates().start(prepared, followUp, signal())).outcome).toBe('merged');
      await delivery.commit(prepared, followUp, DONE, signal());
      const second = await delivery.deliver(prepared, followUp, DONE, signal());

      const ref = `refs/heads/${prepared.runBranch}`;
      expect(second).toMatchObject({
        outcome: 'delivered',
        pullRequest: { number: 1 },
        pushedCommit: headOf(prepared),
      });
      // Only ever `push -- <remote> <ref>:<ref>`: no `+`, no --force, no --force-with-lease.
      const pushes = gitRunner.calls
        .filter((call) => call.args[0] === 'push')
        .map((call) => call.args);
      expect(pushes).toHaveLength(2);
      for (const args of pushes) {
        expect(args).toEqual(['push', '--', remote.url, `${ref}:${ref}`]);
        expect(args.some((arg) => arg.startsWith('+') || arg.includes('force'))).toBe(false);
      }
      // No rebase or pull ever ran in the Working copy.
      expect(gitRunner.calls.some((call) => ['rebase', 'pull'].includes(call.args[0] ?? ''))).toBe(
        false,
      );
      // The remote Run branch moved forward: the earlier pushed tip is its first parent, and the
      // integration commit its second, so history was only added to.
      expect(git(bare(), ['rev-parse', ref], env)).toBe(headOf(prepared));
      expect(parentsOf(prepared)).toEqual([pushedBefore, tip]);
      expect(() =>
        git(bare(), ['merge-base', '--is-ancestor', pushedBefore, ref], env),
      ).not.toThrow();
    });
  });
});
