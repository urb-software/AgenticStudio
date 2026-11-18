import type { RunDiff, RunPayload } from '@agentic-studio/contracts';
import { reportRunDiffRequestSchema } from '@agentic-studio/contracts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitRunner } from '../git.js';
import { RunDiffs, RunDiffUnavailableError } from '../run-diff.js';
import { type PreparedRun, WorkingCopies } from '../working-copy.js';
import { createRemote, type FixtureRemote, git, isolatedGitEnv } from './fixtures/git-fixture.js';

// A Run's diffs computed from a real Working copy on fixture repositories.

const AGENT = { agentGitName: 'Studio Agent', agentGitEmail: 'agent@example.test' };
const LIMITS = { filePatchBytes: 256 * 1024, patchBytes: 2048 * 1024, files: 1000 };
const WORKER_ID = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';

describe.skipIf(process.platform !== 'linux')('RunDiffs', () => {
  let root: string;
  let dataDir: string;
  let home: string;
  let env: Record<string, string>;
  let remote: FixtureRemote;
  let first: string;
  let logs: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'studio-diff-'));
    dataDir = join(root, 'data');
    home = join(root, 'home');
    mkdirSync(home);
    env = isolatedGitEnv(home);
    remote = createRemote(join(root, 'acme'), 'shop', env);
    first = remote.commit('Initial commit', {
      'README.md': '# Shop\n',
      'src/app.ts': 'export const a = 1;\nexport const b = 2;\n',
      'src/old-name.ts': 'export const moved = true;\n'.repeat(5),
      'docs/remove-me.md': 'Gone soon.\n',
    });
    logs = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const logger = { error: (message: string) => logs.push(message) };
  const runner = () => new GitRunner({ env: { PATH: env.PATH!, HOME: home } });
  const diffs = (limits = LIMITS) => new RunDiffs({ dataDir, git: runner(), limits, logger });
  const signal = () => new AbortController().signal;

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

  /** What an agent does in its Working copy: writes (or, with `null`, deletes) files. */
  function agentWrites(
    prepared: PreparedRun,
    files: Record<string, string | Buffer | null>,
    commit?: string,
  ) {
    for (const [path, content] of Object.entries(files)) {
      const target = join(prepared.repoDir, path);
      if (content === null) unlinkSync(target);
      else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    }
    if (commit) {
      inRepo(prepared, ['add', '--all']);
      inRepo(prepared, ['commit', '--quiet', '-m', commit]);
    }
  }

  const byPath = (diff: RunDiff) => new Map(diff.files.map((file) => [file.path, file]));

  it('lists added, modified, deleted, renamed and binary files with counts and patches', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(
      prepared,
      {
        'src/app.ts': 'export const a = 1;\nexport const b = 3;\nexport const c = 4;\n',
        'docs/remove-me.md': null,
        'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]),
      },
      'Change files',
    );
    inRepo(prepared, ['mv', 'src/old-name.ts', 'src/new-name.ts']);
    inRepo(prepared, ['commit', '--quiet', '-m', 'Rename']);
    agentWrites(prepared, { 'README.md': '# Shop\n\nMore.\n', 'notes/todo.md': 'Todo\n' });

    const computed = await diffs().compute(prepared, run, signal());
    const { run: whole, last } = computed.report;

    expect(whole.baseCommit).toBe(first);
    expect(whole.truncated).toBe(false);
    expect(whole.includesUnpushed).toBe(true);
    const files = byPath(whole);
    expect([...files.keys()].sort()).toEqual([
      'README.md',
      'docs/remove-me.md',
      'logo.png',
      'notes/todo.md',
      'src/app.ts',
      'src/new-name.ts',
    ]);
    expect(files.get('src/app.ts')).toMatchObject({
      status: 'modified',
      additions: 2,
      deletions: 1,
    });
    expect(files.get('src/app.ts')?.patch).toContain('+export const c = 4;');
    expect(files.get('src/app.ts')?.patch).toContain('-export const b = 2;');
    expect(files.get('docs/remove-me.md')).toMatchObject({ status: 'deleted', deletions: 1 });
    expect(files.get('notes/todo.md')).toMatchObject({ status: 'added', additions: 1 });
    expect(files.get('README.md')).toMatchObject({ status: 'modified', additions: 2 });
    expect(files.get('src/new-name.ts')).toMatchObject({
      status: 'renamed',
      previousPath: 'src/old-name.ts',
      additions: 0,
      deletions: 0,
    });
    const binary = files.get('logo.png');
    expect(binary).toMatchObject({ status: 'added', binary: true });
    expect(binary).not.toHaveProperty('patch');
    // The first result: "since the previous result" is the whole Run.
    expect(last).toEqual(whole);
    expect(
      reportRunDiffRequestSchema.safeParse({ workerId: WORKER_ID, ...computed.report }).success,
    ).toBe(true);
  });

  it('leaves the real index untouched', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'staged.md': 'staged\n', 'unstaged.md': 'unstaged\n' });
    inRepo(prepared, ['add', 'staged.md']);
    const before = inRepo(prepared, ['status', '--porcelain=v1']);

    await diffs().compute(prepared, run, signal());

    expect(inRepo(prepared, ['status', '--porcelain=v1'])).toBe(before);
  });

  it('never includes the Environment file, even when the agent committed it', async () => {
    const run = payload({
      studioPaths: ['config/.env'],
      environmentFile: { path: 'config/.env', content: 'SECRET=test-only-value\n' },
    });
    const prepared = await prepare(run);
    agentWrites(prepared, { 'src/app.ts': 'export const a = 2;\n' });

    const untouched = await diffs().compute(prepared, run, signal());
    expect(untouched.report.run.files.map((file) => file.path)).toEqual(['src/app.ts']);

    // Forced in and committed: still not part of the diff.
    inRepo(prepared, ['add', '--force', 'config/.env']);
    inRepo(prepared, ['commit', '--quiet', '-m', 'Leak the settings']);
    const forced = await diffs().compute(prepared, run, signal());
    expect(forced.report.run.files.map((file) => file.path)).toEqual(['src/app.ts']);
    expect(JSON.stringify(forced.report)).not.toContain('test-only-value');
  });

  it('since the previous result: only what changed after it, from the commit it was at', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'one.md': 'one\n' }, 'First result');
    const firstHead = inRepo(prepared, ['rev-parse', 'HEAD']);
    const subject = diffs();
    const first = await subject.compute(prepared, run, signal());
    // Studio keeps the state and hands it back with the next claim.
    expect(first.report.state).toMatchObject({
      resultCommit: firstHead,
      previousCommit: run.startCommit,
    });

    agentWrites(prepared, { 'two.md': 'two\n' });
    const second = await subject.compute(
      prepared,
      { ...run, diffState: first.report.state },
      signal(),
    );

    expect(second.report.run.files.map((file) => file.path).sort()).toEqual(['one.md', 'two.md']);
    expect(second.report.last.files.map((file) => file.path)).toEqual(['two.md']);
    expect(second.report.last.baseCommit).toBe(firstHead);

    // A refresh (a delivery retry, no new result) keeps "since the previous result" as it was.
    inRepo(prepared, ['add', '--all']);
    inRepo(prepared, ['commit', '--quiet', '-m', 'Commit what was left']);
    const refreshed = await subject.compute(
      prepared,
      { ...run, diffState: second.report.state },
      signal(),
      { refresh: true },
    );
    expect(refreshed.report.last.files.map((file) => file.path)).toEqual(['two.md']);
    expect(refreshed.report.last.baseCommit).toBe(firstHead);
  });

  it('applies the limits: a file over its limit, the total, and the number of files', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, {
      'a-big.txt': 'x'.repeat(200) + '\n',
      'b-small.txt': 'small\n',
      'c-small.txt': 'small\n',
      'd-small.txt': 'small\n',
    });

    const limited = await diffs({ filePatchBytes: 180, patchBytes: 320, files: 1000 }).compute(
      prepared,
      run,
      signal(),
    );
    const files = limited.report.run.files;
    expect(files.map((file) => file.path)).toEqual([
      'a-big.txt',
      'b-small.txt',
      'c-small.txt',
      'd-small.txt',
    ]);
    expect(files[0]).toMatchObject({ tooLarge: true, additions: 1 });
    expect(files[0]).not.toHaveProperty('patch');
    expect(files[1]?.patch).toContain('+small');
    // Once the total is reached, the rest are listed with their counts but no content.
    expect(files.at(-1)).toMatchObject({ additions: 1 });
    expect(files.at(-1)).not.toHaveProperty('patch');
    expect(limited.report.run.truncated).toBe(true);

    const fewer = await diffs({ ...LIMITS, files: 2 }).compute(prepared, run, signal());
    expect(fewer.report.run.files).toHaveLength(2);
    expect(fewer.report.run.truncated).toBe(true);
  });

  it('a Run with no changes has an empty diff and nothing unpushed', async () => {
    const run = payload();
    const prepared = await prepare(run);

    const computed = await diffs().compute(prepared, run, signal());

    expect(computed.report.run).toEqual({
      baseCommit: first,
      includesUnpushed: false,
      truncated: false,
      files: [],
    });
  });

  it('once the Run branch is pushed, its committed changes count as pushed', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'one.md': 'one\n' }, 'Change');
    const subject = diffs();
    const computed = await subject.compute(prepared, run, signal());
    expect(computed.report.run.includesUnpushed).toBe(true);

    const pushed = await subject.pushed(prepared, computed, signal());
    expect(pushed.run.includesUnpushed).toBe(false);
    expect(pushed.last.includesUnpushed).toBe(false);
    expect(pushed.state.pushedCommit).toBe(inRepo(prepared, ['rev-parse', 'HEAD']));

    // The pushed tip comes back with the state: still pushed, until something changes.
    const again = { ...run, diffState: pushed.state };
    expect((await subject.compute(prepared, again, signal())).report.run.includesUnpushed).toBe(
      false,
    );
    agentWrites(prepared, { 'two.md': 'two\n' });
    expect((await subject.compute(prepared, again, signal())).report.run.includesUnpushed).toBe(
      true,
    );
  });

  it('ignores a state whose objects are not the trees and commits it names', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'one.md': 'one\n' }, 'Change');
    const head = inRepo(prepared, ['rev-parse', 'HEAD']);
    const headTree = inRepo(prepared, ['rev-parse', 'HEAD^{tree}']);
    // A commit where a tree belongs, and a pushed commit that is not an object here.
    const forged = {
      resultTree: head,
      resultCommit: head,
      previousTree: headTree,
      previousCommit: head,
      pushedCommit: 'f'.repeat(40),
    };

    const computed = await diffs().compute(prepared, { ...run, diffState: forged }, signal());

    expect(computed.report.last.baseCommit).toBe(run.startCommit);
    expect(computed.report.last.files.map((file) => file.path)).toEqual(['one.md']);
    expect(computed.report.run.includesUnpushed).toBe(true);
  });

  it('a committed Studio-placed path does not keep the changes unpushed', async () => {
    const run = payload({
      studioPaths: ['.env'],
      environmentFile: { path: '.env', content: 'SECRET=test-only-value\n' },
    });
    const prepared = await prepare(run);
    inRepo(prepared, ['add', '--force', '--all']);
    inRepo(prepared, ['commit', '--quiet', '-m', 'Everything, the settings too']);
    const subject = diffs();

    const computed = await subject.compute(prepared, run, signal());
    const pushed = await subject.pushed(prepared, computed, signal());

    expect(pushed.run.includesUnpushed).toBe(false);
  });

  it('says why when the Working copy cannot be read, without Git output or paths', async () => {
    const run = payload();
    const prepared = await prepare(run);
    rmSync(join(prepared.repoDir, '.git'), { recursive: true, force: true });

    const error = await diffs()
      .compute(prepared, run, signal())
      .then(
        () => null,
        (failure: unknown) => failure,
      );

    expect(error).toBeInstanceOf(RunDiffUnavailableError);
    expect((error as RunDiffUnavailableError).detail).toMatch(/^The changes could not be computed/);
    expect((error as RunDiffUnavailableError).detail).not.toContain(root);
  });
});
