import type { RunPayload, RunStepResult } from '@agentic-studio/contracts';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Deliveries, DeliveryFailedError, NO_WORKING_COPY } from '../delivery.js';
import { type GitOptions, GitRunner } from '../git.js';
import { type PreparedRun, WorkingCopies } from '../working-copy.js';
import { createRemote, type FixtureRemote, git, isolatedGitEnv } from './fixtures/git-fixture.js';
import { type StubGitHub, startStubGitHub } from './fixtures/stub-github.js';

// Issue #102: delivering a Run's result from its real Working copy to a fixture remote
// (file://, no network) and a local stub of GitHub's pull request API. Linux only, like the
// worker; runs in CI on Linux.

const AGENT = { agentGitName: 'Studio Agent', agentGitEmail: 'agent@example.test' };
const DONE: RunStepResult = {
  outcome: 'done',
  summary: 'Add pagination to the product list\n\nPages of 20 products.',
  pullRequest: { title: 'Add pagination', body: 'Pages of 20 products.' },
  checks: [{ name: 'unit tests', result: 'passed' }],
};

/** Records every Git command; a push can be intercepted (never run) for an https remote. */
class RecordingGit extends GitRunner {
  readonly calls: { args: readonly string[]; options: GitOptions }[] = [];
  interceptPush = false;
  /** The config file of the repository each push ran in, read just before it ran. */
  readonly pushConfigs: string[] = [];

  override run(args: readonly string[], options: GitOptions): Promise<string> {
    this.calls.push({ args, options });
    if (args[0] === 'push') {
      this.pushConfigs.push(readFileSync(join(options.cwd, 'config'), 'utf8'));
    }
    if (this.interceptPush && args[0] === 'push') return Promise.resolve('');
    return super.run(args, options);
  }

  pushes() {
    return this.calls.filter((call) => call.args[0] === 'push');
  }
}

describe.skipIf(process.platform !== 'linux')('Deliveries', () => {
  let root: string;
  let dataDir: string;
  let home: string;
  let env: Record<string, string>;
  let remote: FixtureRemote;
  let first: string;
  let stub: StubGitHub;
  let gitRunner: RecordingGit;
  let logs: string[];
  // A throwaway value generated per run; never a real token.
  const token = `ghp_${randomBytes(18).toString('hex')}`;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'studio-delivery-'));
    dataDir = join(root, 'data');
    home = join(root, 'home');
    mkdirSync(home);
    env = isolatedGitEnv(home);
    // Under acme/: a development or test worker names a file:// remote by its last two parts.
    remote = createRemote(join(root, 'acme'), 'shop', env);
    first = remote.commit('Initial commit', { 'README.md': '# Shop\n' });
    stub = await startStubGitHub();
    gitRunner = new RecordingGit({ env: { PATH: env.PATH!, HOME: home } });
    logs = [];
  });

  afterEach(async () => {
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  const logger = { error: (message: string) => logs.push(message) };

  function deliveries(github: { token?: string; apiUrl?: string } = { token }) {
    return new Deliveries({
      dataDir,
      git: gitRunner,
      ...AGENT,
      allowFileRemotes: true,
      github: { apiUrl: stub.url, ...github },
      logger,
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
      integrationBranch: 'main',
      kind: 'start',
      studioPaths: [],
      limits: { stepMinutes: 60, maxSteps: 10 },
      completedSteps: 0,
      ...overrides,
    };
  }

  async function prepare(run = payload()): Promise<PreparedRun> {
    return new WorkingCopies({
      dataDir,
      git: new GitRunner({ env: { PATH: env.PATH!, HOME: home } }),
      ...AGENT,
      allowFileRemotes: true,
      logger,
    }).prepare(run, signal());
  }

  const signal = () => new AbortController().signal;
  const bare = () => join(root, 'acme', 'shop.git');
  const remoteBranches = () =>
    git(bare(), ['for-each-ref', '--format=%(refname)', 'refs/'], env).split('\n').sort();
  const inRepo = (prepared: PreparedRun, args: string[]) => git(prepared.repoDir, args, env);

  /** What an agent does in its Working copy: writes files and, if asked, commits them. */
  function agentWrites(prepared: PreparedRun, files: Record<string, string>, commit?: string) {
    for (const [path, content] of Object.entries(files)) {
      writeFileSync(join(prepared.repoDir, path), content);
    }
    if (commit) {
      inRepo(prepared, ['add', '--all']);
      inRepo(prepared, ['commit', '--quiet', '-m', commit]);
    }
  }

  async function finish(run: RunPayload, prepared: PreparedRun, result = DONE) {
    const subject = deliveries();
    await subject.commit(prepared, run, result, signal());
    return subject.deliver(prepared, run, result, signal());
  }

  it("pushes the agent's commits on the Run branch and opens a draft pull request", async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'pages.ts': 'export const PAGE = 20;\n' }, 'Add pagination');

    const delivery = await finish(run, prepared);

    expect(delivery).toEqual({
      outcome: 'delivered',
      pullRequest: { url: 'https://github.com/acme/shop/pull/1', number: 1 },
      // Issue #141: the commit the push left the remote Run branch at.
      pushedCommit: inRepo(prepared, ['rev-parse', 'HEAD']),
    });
    expect(git(bare(), ['rev-parse', `refs/heads/${prepared.runBranch}`], env)).toBe(
      inRepo(prepared, ['rev-parse', 'HEAD']),
    );
    expect(stub.created).toEqual([
      {
        owner: 'acme',
        repo: 'shop',
        body: expect.objectContaining({
          title: 'Add pagination',
          head: prepared.runBranch,
          base: 'main',
          draft: true,
        }),
      },
    ]);
    const body = String(stub.created[0]?.body.body);
    expect(body).toMatch(/^Pages of 20 products\./);
    expect(body).toContain(`- Run: \`${run.runId}\``);
    expect(body).toContain('- Provider: Claude Code');
    expect(body).toContain(`- Start commit: \`${first}\``);
    expect(body).toContain('  - passed: `unit tests`');
  });

  it('pushes exactly the Run branch, by its own refspec, without --force, and no other ref', async () => {
    const run = payload();
    const prepared = await prepare(run);
    // The agent also made a branch and a tag of its own: neither may leave the host.
    agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');
    inRepo(prepared, ['branch', 'agent-side-branch']);
    inRepo(prepared, ['tag', 'v-agent']);

    await finish(run, prepared);

    const ref = `refs/heads/${prepared.runBranch}`;
    expect(gitRunner.pushes().map((call) => call.args)).toEqual([
      ['push', '--', remote.url, `${ref}:${ref}`],
    ]);
    expect(remoteBranches()).toEqual(['refs/heads/main', ref].sort());
  });

  it('commits what the agent left uncommitted as the Agent account, with a message from the summary', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'pages.ts': 'x\n', 'notes.md': 'y\n' });

    await finish(run, prepared);

    expect(inRepo(prepared, ['status', '--porcelain'])).toBe('');
    expect(inRepo(prepared, ['log', '-1', '--format=%an <%ae>|%cn <%ce>'])).toBe(
      'Studio Agent <agent@example.test>|Studio Agent <agent@example.test>',
    );
    expect(inRepo(prepared, ['log', '-1', '--format=%B'])).toBe(
      'agent: Add pagination to the product list\n\nAdd pagination to the product list\n\nPages of 20 products.',
    );
    expect(git(bare(), ['ls-tree', '--name-only', `refs/heads/${prepared.runBranch}`], env)).toBe(
      'README.md\nnotes.md\npages.ts',
    );
  });

  it('commits as the Agent account even when the agent changed the Working copy identity', async () => {
    const run = payload();
    const prepared = await prepare(run);
    inRepo(prepared, ['config', 'user.name', 'Someone Else']);
    inRepo(prepared, ['config', 'user.email', 'else@example.test']);
    agentWrites(prepared, { 'pages.ts': 'x\n' });

    await deliveries().commit(prepared, run, DONE, signal());

    expect(inRepo(prepared, ['log', '-1', '--format=%an <%ae>'])).toBe(
      'Studio Agent <agent@example.test>',
    );
  });

  it('cuts the first line of the commit message at 72 characters', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'pages.ts': 'x\n' });

    await deliveries().commit(prepared, run, { ...DONE, summary: 's'.repeat(100) }, signal());

    const subject = inRepo(prepared, ['log', '-1', '--format=%s']);
    expect(subject).toBe(`agent: ${'s'.repeat(65)}`);
    expect(subject).toHaveLength(72);
  });

  it('pushes nothing and opens no pull request when the Run branch has no new commits', async () => {
    const run = payload();
    const prepared = await prepare(run);

    const delivery = await finish(run, prepared);

    expect(delivery).toEqual({ outcome: 'none' });
    expect(gitRunner.pushes()).toEqual([]);
    expect(remoteBranches()).toEqual(['refs/heads/main']);
    expect(stub.requests).toEqual([]);
  });

  it('never commits or pushes a file Studio placed, even one the agent forced into the index', async () => {
    const run = payload();
    const prepared = await prepare(run);
    // As #104 will: the Environment file in the Working copy, listed in Studio's exclude section
    // and in the Run file.
    appendFileSync(join(prepared.repoDir, '.git', 'info', 'exclude'), '/.env.studio\n');
    const runFile = join(prepared.runDir, 'run.json');
    const recorded = JSON.parse(readFileSync(runFile, 'utf8')) as Record<string, unknown>;
    writeFileSync(runFile, JSON.stringify({ ...recorded, studioPaths: ['config/studio.env'] }));
    mkdirSync(join(prepared.repoDir, 'config'));
    agentWrites(prepared, {
      '.env.studio': 'API_KEY=placed-by-studio\n',
      'config/studio.env': 'DB_PASSWORD=placed-by-studio\n',
      'pages.ts': 'x\n',
    });
    inRepo(prepared, ['add', '--force', '.env.studio', 'config/studio.env']);

    await finish(run, prepared);

    const pushed = git(
      bare(),
      ['ls-tree', '-r', '--name-only', `refs/heads/${prepared.runBranch}`],
      env,
    ).split('\n');
    expect(pushed).toEqual(['README.md', 'pages.ts']);
    expect(git(bare(), ['log', '--all', '--format=%H', '--', '.env.studio'], env)).toBe('');
  });

  it("refuses to push when one of the agent's commits contains a file Studio placed", async () => {
    const run = payload();
    const prepared = await prepare(run);
    appendFileSync(join(prepared.repoDir, '.git', 'info', 'exclude'), '/.env.studio\n');
    agentWrites(prepared, { '.env.studio': 'API_KEY=placed-by-studio\n' });
    inRepo(prepared, ['add', '--force', '.env.studio']);
    inRepo(prepared, ['commit', '--quiet', '-m', 'Oops']);
    // Removing it in a later commit does not take it out of the history.
    inRepo(prepared, ['rm', '--quiet', '--cached', '.env.studio']);
    inRepo(prepared, ['commit', '--quiet', '-m', 'Remove it again']);

    const error = await finish(run, prepared).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeliveryFailedError);
    expect((error as DeliveryFailedError).detail).toMatch(
      /contains \.env\.studio, a file Studio placed/,
    );
    expect(gitRunner.pushes()).toEqual([]);
    expect(remoteBranches()).toEqual(['refs/heads/main']);
  });

  it('fails with what to check when the push is refused, and opens no pull request', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');
    // Someone else pushed a different commit to the Run branch's name on the remote.
    const other = join(root, 'other');
    git(root, ['clone', '--quiet', remote.url, other], env);
    writeFileSync(join(other, 'elsewhere.md'), 'z\n');
    git(other, ['add', '--all'], env);
    git(other, ['commit', '--quiet', '-m', 'Not this Run'], env);
    git(other, ['push', '--quiet', 'origin', `HEAD:refs/heads/${prepared.runBranch}`], env);

    const error = await finish(run, prepared).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeliveryFailedError);
    expect((error as DeliveryFailedError).detail).toMatch(/Pushing the Run branch was refused/);
    expect(stub.created).toEqual([]);
  });

  it('opens the pull request on a retry after GitHub refused it, without a second push of new commits', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');
    stub.failCreate = 503;

    const attempt = await finish(run, prepared).catch((caught: unknown) => caught);
    expect(attempt).toBeInstanceOf(DeliveryFailedError);
    expect((attempt as DeliveryFailedError).detail).toMatch(/GitHub answered 503/);

    const retry = deliveries();
    const located = await retry.locate({ ...run, kind: 'deliver', runBranch: prepared.runBranch });
    await retry.commit(located.prepared, run, located.result, signal());
    const delivery = await retry.deliver(located.prepared, run, located.result, signal());

    expect(delivery).toMatchObject({ outcome: 'delivered', pullRequest: { number: 1 } });
    expect(stub.created).toHaveLength(1);
  });

  it('refuses a retry from a Working copy that is not on its Run branch (coordinator decision on #103)', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');
    await deliveries().commit(prepared, run, DONE, signal());
    inRepo(prepared, ['checkout', '--quiet', '-b', 'elsewhere']);

    const attempt = await deliveries()
      .locate({ ...run, kind: 'deliver', runBranch: prepared.runBranch, nextSeq: 1 })
      .catch((caught: unknown) => caught);

    expect(attempt).toBeInstanceOf(DeliveryFailedError);
    expect((attempt as DeliveryFailedError).detail).toMatch(/not on its Run branch/);
    expect(stub.created).toHaveLength(0);
  });

  // Issue #141: a Follow-up delivers again, to the same pull request.
  describe('repeated delivery after a Follow-up (Issue #141)', () => {
    /** The first part of the Run, delivered: its pull request is #1. */
    async function deliveredOnce() {
      const run = payload();
      const prepared = await prepare(run);
      agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');
      await finish(run, prepared);
      const followUp: RunPayload = {
        ...run,
        kind: 'resume',
        runBranch: prepared.runBranch,
        sessionRef: 'session-1',
        answer: 'Also handle the empty list.',
        resumeReason: 'follow_up',
        followUpNumber: 1,
        nextSeq: 10,
        completedSteps: 1,
        stepsBeforePart: 1,
        pullRequestNumber: 1,
      };
      return { run: followUp, prepared };
    }

    it('pushes the new commits and updates the same pull request, never opening a second one', async () => {
      const { run, prepared } = await deliveredOnce();
      agentWrites(prepared, { 'empty.ts': 'y\n' }, 'Handle the empty list');
      const requestsBefore = stub.requests.length;

      const delivery = await finish(run, prepared, {
        ...DONE,
        pullRequest: { title: 'Add pagination and empty lists', body: 'Now with empty lists.' },
      });

      const head = inRepo(prepared, ['rev-parse', 'HEAD']);
      expect(delivery).toEqual({
        outcome: 'delivered',
        pullRequest: { url: 'https://github.com/acme/shop/pull/1', number: 1 },
        pushedCommit: head,
      });
      expect(git(bare(), ['rev-parse', `refs/heads/${prepared.runBranch}`], env)).toBe(head);
      expect(stub.created).toHaveLength(1);
      expect(stub.updated).toHaveLength(1);
      expect(stub.updated[0]?.body.title).toBe('Add pagination and empty lists');
      const body = String(stub.updated[0]?.body.body);
      expect(body).toMatch(/^Now with empty lists\./);
      expect(body).toContain('_Delivered by AI Agent Studio._');
      expect(body).toContain(`- Run: \`${run.runId}\``);
      // Exactly one ref, never forced, on every push.
      const ref = `refs/heads/${prepared.runBranch}`;
      expect(gitRunner.pushes().map((call) => call.args)).toEqual([
        ['push', '--', remote.url, `${ref}:${ref}`],
        ['push', '--', remote.url, `${ref}:${ref}`],
      ]);
      expect(
        stub.requests
          .slice(requestsBefore)
          .some((request) => request.method === 'POST' || request.path.endsWith('/pulls')),
      ).toBe(false);
    });

    // Review S7 of #150: only what the agent gave replaces the old text.
    it('replaces only the title when the agent gave a title without a description', async () => {
      const { run, prepared } = await deliveredOnce();
      agentWrites(prepared, { 'empty.ts': 'y\n' }, 'Handle the empty list');

      await finish(run, prepared, {
        ...DONE,
        pullRequest: { title: 'A better title', body: '  ' },
      });

      expect(stub.updated).toHaveLength(1);
      expect(stub.updated[0]?.body).toEqual({ title: 'A better title' });
    });

    it('keeps the title and description when the agent gave no new ones', async () => {
      const { run, prepared } = await deliveredOnce();
      agentWrites(prepared, { 'empty.ts': 'y\n' }, 'Handle the empty list');

      await finish(run, prepared, { outcome: 'done', summary: 'Handled the empty list.' });

      expect(stub.updated).toEqual([]);
      expect(stub.created).toHaveLength(1);
    });

    it.each([
      ['closed', false],
      ['merged', true],
    ])(
      'refuses to deliver to a %s pull request, before anything is pushed',
      async (word, merged) => {
        const { run, prepared } = await deliveredOnce();
        stub.pullRequests[0]!.state = 'closed';
        stub.pullRequests[0]!.merged = merged;
        agentWrites(prepared, { 'empty.ts': 'y\n' }, 'Handle the empty list');
        const remoteTip = git(bare(), ['rev-parse', `refs/heads/${prepared.runBranch}`], env);

        const error = await finish(run, prepared).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(DeliveryFailedError);
        expect((error as DeliveryFailedError).detail).toMatch(
          new RegExp(`pull request #1 is ${word} on GitHub`),
        );
        expect((error as DeliveryFailedError).branchPushed).toBe(false);
        expect(git(bare(), ['rev-parse', `refs/heads/${prepared.runBranch}`], env)).toBe(remoteTip);
        expect(gitRunner.pushes()).toHaveLength(1);
        expect(stub.created).toHaveLength(1);
      },
    );

    it('says what was pushed when the update of the pull request fails after the push', async () => {
      const { run, prepared } = await deliveredOnce();
      agentWrites(prepared, { 'empty.ts': 'y\n' }, 'Handle the empty list');
      stub.failUpdate = 502;

      const error = await finish(run, prepared).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DeliveryFailedError);
      expect((error as DeliveryFailedError).detail).toMatch(
        /Updating the run's pull request failed/,
      );
      expect((error as DeliveryFailedError).branchPushed).toBe(true);
      expect((error as DeliveryFailedError).pushedCommit).toBe(
        inRepo(prepared, ['rev-parse', 'HEAD']),
      );
      expect(stub.created).toHaveLength(1);
    });

    it('opens a draft pull request when the Run had none yet and now has commits', async () => {
      const run = payload();
      const prepared = await prepare(run);
      // The first part changed nothing: "No changes", no pull request.
      expect(await finish(run, prepared)).toEqual({ outcome: 'none' });
      const followUp: RunPayload = {
        ...run,
        kind: 'resume',
        runBranch: prepared.runBranch,
        sessionRef: 'session-1',
        answer: 'Now add pagination.',
        resumeReason: 'follow_up',
        followUpNumber: 1,
        nextSeq: 5,
        completedSteps: 1,
        stepsBeforePart: 1,
      };
      agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');

      const delivery = await finish(followUp, prepared);

      expect(delivery).toMatchObject({ outcome: 'delivered', pullRequest: { number: 1 } });
      expect(stub.created).toEqual([
        expect.objectContaining({ body: expect.objectContaining({ draft: true, base: 'main' }) }),
      ]);
    });
  });

  it('reuses the pull request on a repeated delivery instead of opening a second one', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');

    const once = await finish(run, prepared);
    const twice = await finish(run, prepared);

    expect(twice).toEqual(once);
    expect(stub.created).toHaveLength(1);
  });

  it('opens the pull request even when the agent reports failing checks, and says so first', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');

    await finish(run, prepared, {
      ...DONE,
      checks: [
        { name: 'lint', result: 'passed' },
        { name: 'unit tests', result: 'failed' },
        { name: 'e2e', result: 'not_run' },
      ],
    });

    const body = String(stub.created[0]?.body.body);
    expect(body).toMatch(
      /^> \*\*Failing checks:\*\* the agent reported that this check failed: `unit tests`\./,
    );
    expect(body).toContain('  - passed: `lint`\n  - failed: `unit tests`\n  - not run: `e2e`');
  });

  it('takes the title from the Task and the description from the summary when the agent gave none', async () => {
    const run = payload({ task: 'Add pagination to the list\nwith pages of 20' });
    const prepared = await prepare(run);
    agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');

    await finish(run, prepared, { outcome: 'done', summary: 'Added pages of 20.' });

    expect(stub.created[0]?.body).toMatchObject({ title: 'Add pagination to the list' });
    expect(String(stub.created[0]?.body.body)).toMatch(/^Added pages of 20\.\n\n---/);
    expect(String(stub.created[0]?.body.body)).toContain('- Checks: none reported');
  });

  it('passes the token to an HTTPS push only through its environment, never argv, config or log', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');
    gitRunner.interceptPush = true;
    const https = { ...run, repository: { remoteUrl: 'https://github.com/acme/shop.git' } };

    await finish(https, prepared);

    const [push] = gitRunner.pushes();
    expect(push?.args.join(' ')).not.toContain(token);
    const header = push?.options.config?.find(
      ([key]) => key === 'http.https://github.com/.extraHeader',
    );
    expect(header?.[1]).toBe(
      `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    );
    const everywhere = [
      readFileSync(join(prepared.repoDir, '.git', 'config'), 'utf8'),
      JSON.stringify(gitRunner.calls.filter((call) => call.args[0] !== 'push')),
      logs.join('\n'),
    ].join('\n');
    expect(everywhere).not.toContain(token);
    expect(everywhere).not.toContain(Buffer.from(`x-access-token:${token}`).toString('base64'));
  });

  it("gives an SSH push no token: the agent user's own SSH setup is used", async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');
    gitRunner.interceptPush = true;

    await finish({ ...run, repository: { remoteUrl: 'git@github.com:acme/shop.git' } }, prepared);

    expect(JSON.stringify(gitRunner.pushes())).not.toContain('extraHeader');
  });

  it('fails as not configured, pushing nothing, when the worker has no Agent account token', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');
    const subject = deliveries({});
    await subject.commit(prepared, run, DONE, signal());

    const error = await subject
      .deliver(prepared, run, DONE, signal())
      .catch((caught: unknown) => caught);

    expect((error as DeliveryFailedError).detail).toMatch(
      /^Agent account not configured on the agent worker/,
    );
    expect(gitRunner.pushes()).toEqual([]);
  });

  it('fails as not supported, pushing nothing, for a remote that is not on GitHub', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');
    gitRunner.interceptPush = true;

    const error = await finish(
      { ...run, repository: { remoteUrl: 'https://gitlab.com/acme/shop.git' } },
      prepared,
    ).catch((caught: unknown) => caught);

    expect((error as DeliveryFailedError).detail).toMatch(/^Git host not supported/);
    expect(gitRunner.pushes()).toEqual([]);
  });

  it('refuses to commit leftovers when the agent left the Run branch', async () => {
    const run = payload();
    const prepared = await prepare(run);
    inRepo(prepared, ['checkout', '--quiet', '-b', 'elsewhere']);
    agentWrites(prepared, { 'pages.ts': 'x\n' });

    const error = await deliveries()
      .commit(prepared, run, DONE, signal())
      .catch((caught: unknown) => caught);

    expect((error as DeliveryFailedError).detail).toMatch(/not on the Run branch/);
  });

  it("never lets the Working copy's own Git config redirect the push (review of #122)", async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');
    // The agent points pushes to the Project's remote at a remote of its own.
    const decoy = createRemote(join(root, 'decoy'), 'shop', env);
    decoy.commit('Decoy', { 'x.md': 'x\n' });
    inRepo(prepared, ['config', `url.${decoy.url}.pushInsteadOf`, remote.url]);
    inRepo(prepared, ['config', 'credential.helper', '!echo leaked >&2']);

    await finish(run, prepared);

    const ref = `refs/heads/${prepared.runBranch}`;
    expect(git(bare(), ['rev-parse', ref], env)).toBe(inRepo(prepared, ['rev-parse', 'HEAD']));
    expect(git(join(root, 'decoy', 'shop.git'), ['for-each-ref', '--format=%(refname)'], env)).toBe(
      'refs/heads/main',
    );
    const [push] = gitRunner.pushes();
    expect(push?.options.cwd).toBe(join(prepared.runDir, 'push.git'));
  });

  it('scopes the HTTPS push header to github.com and reads no user Git config for it', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');
    gitRunner.interceptPush = true;

    await finish(
      { ...run, repository: { remoteUrl: 'https://github.com/acme/shop.git' } },
      prepared,
    );

    const [push] = gitRunner.pushes();
    expect(push?.options.userConfig).toBe(false);
    expect(push?.options.config?.map(([key]) => key)).toContain(
      'http.https://github.com/.extraHeader',
    );
    expect(push?.options.config?.map(([key]) => key)).not.toContain('http.extraHeader');
  });

  it("keeps files matching a pattern in Studio's exclude section out, at any depth", async () => {
    const run = payload();
    const prepared = await prepare(run);
    appendFileSync(join(prepared.repoDir, '.git', 'info', 'exclude'), '*.studio-env\n');
    mkdirSync(join(prepared.repoDir, 'deep'));
    agentWrites(prepared, {
      'deep/app.studio-env': 'SECRET=1\n',
      'pages.ts': 'x\n',
    });
    inRepo(prepared, ['add', '--force', 'deep/app.studio-env']);

    await finish(run, prepared);

    expect(
      git(bare(), ['ls-tree', '-r', '--name-only', `refs/heads/${prepared.runBranch}`], env),
    ).toBe('README.md\npages.ts');
  });

  it('takes the description from the summary when the agent gave an empty one', async () => {
    const run = payload();
    const prepared = await prepare(run);
    agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');

    await finish(run, prepared, {
      outcome: 'done',
      summary: 'Added pages of 20.',
      pullRequest: { title: 'Add pagination', body: '  ' },
    });

    expect(String(stub.created[0]?.body.body)).toMatch(/^Added pages of 20\.\n\n---/);
  });

  it('fails a retry whose kept result is gone, though the Working copy is there', async () => {
    const run = payload();
    const prepared = await prepare(run);
    await deliveries().commit(prepared, run, DONE, signal());
    rmSync(join(prepared.runDir, 'result.json'));

    const error = await deliveries()
      .locate({ ...run, kind: 'deliver', runBranch: prepared.runBranch })
      .catch((caught: unknown) => caught);

    expect((error as DeliveryFailedError).detail).toMatch(/result for this Run is no longer/);
  });

  describe('review round 1 of #122', () => {
    it('retries the Run branch Studio recorded, never one named in a rewritten run.json (R1)', async () => {
      const run = payload();
      const prepared = await prepare(run);
      agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');
      await deliveries().commit(prepared, run, DONE, signal());
      // The agent points run.json at the integration branch and gives it a commit of its own.
      const runFile = join(prepared.runDir, 'run.json');
      const recorded = JSON.parse(readFileSync(runFile, 'utf8')) as Record<string, unknown>;
      writeFileSync(
        runFile,
        JSON.stringify({ ...recorded, runBranch: 'main', startCommit: 'f'.repeat(40) }),
      );
      inRepo(prepared, ['branch', '--force', 'main', 'HEAD']);
      const main = git(bare(), ['rev-parse', 'refs/heads/main'], env);

      const retry = deliveries();
      const located = await retry.locate({
        ...run,
        kind: 'deliver',
        runBranch: prepared.runBranch,
      });
      const delivery = await retry.deliver(located.prepared, run, located.result, signal());

      expect(located.prepared.runBranch).toBe(prepared.runBranch);
      expect(located.prepared.startCommit).toBe(first);
      expect(delivery.outcome).toBe('delivered');
      expect(git(bare(), ['rev-parse', 'refs/heads/main'], env)).toBe(main);
      const ref = `refs/heads/${prepared.runBranch}`;
      expect(gitRunner.pushes().map((call) => call.args)).toEqual([
        ['push', '--', remote.url, `${ref}:${ref}`],
      ]);
    });

    it.each([
      ['the integration branch', 'main'],
      ["another Run's branch", 'agent/add-pagination-rdeadbeef'],
      ['a branch outside agent/', 'feature/x'],
    ])('refuses to push %s, pushing nothing (R1)', async (_what, branch) => {
      const run = payload();
      const prepared = await prepare(run);
      agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');
      inRepo(prepared, ['branch', '--force', branch, 'HEAD']);
      const main = git(bare(), ['rev-parse', 'refs/heads/main'], env);

      const error = await deliveries()
        .deliver({ ...prepared, runBranch: branch }, run, DONE, signal())
        .catch((caught: unknown) => caught);

      expect((error as DeliveryFailedError).detail).toMatch(/not a Run branch of this Run/);
      expect(gitRunner.pushes()).toEqual([]);
      expect(git(bare(), ['rev-parse', 'refs/heads/main'], env)).toBe(main);
    });

    it('makes push.git without templates or user config, so a hostile init.templateDir never reaches it (R2)', async () => {
      const run = payload();
      const prepared = await prepare(run);
      agentWrites(prepared, { 'pages.ts': 'x\n' }, 'Add pagination');
      // The agent user's global config names a template whose config redirects pushes.
      const decoy = createRemote(join(root, 'decoy'), 'shop', env);
      decoy.commit('Decoy', { 'x.md': 'x\n' });
      const template = join(root, 'template');
      mkdirSync(template);
      writeFileSync(
        join(template, 'config'),
        `[url "${decoy.url}"]\n\tpushInsteadOf = ${remote.url}\n` +
          '[http]\n\tproxy = http://127.0.0.1:9\n\tsslVerify = false\n',
      );
      git(home, ['config', '--global', 'init.templateDir', template], env);

      await finish(run, prepared);

      const [config] = gitRunner.pushConfigs;
      expect(config).not.toMatch(/insteadof|proxy|sslverify/i);
      expect(git(bare(), ['rev-parse', `refs/heads/${prepared.runBranch}`], env)).toBe(
        inRepo(prepared, ['rev-parse', 'HEAD']),
      );
      expect(
        git(join(root, 'decoy', 'shop.git'), ['for-each-ref', '--format=%(refname)'], env),
      ).toBe('refs/heads/main');
      const init = gitRunner.calls.find((call) => call.args[0] === 'init');
      expect(init?.args).toContain('--template=');
      expect(init?.options.userConfig).toBe(false);
    });

    it("keeps Studio's own list out even when the agent emptied run.json and the exclude section (R3)", async () => {
      const run = payload({ studioPaths: ['.env.studio'] });
      const prepared = await prepare(run);
      writeFileSync(join(prepared.repoDir, '.git', 'info', 'exclude'), '');
      const runFile = join(prepared.runDir, 'run.json');
      const recorded = JSON.parse(readFileSync(runFile, 'utf8')) as Record<string, unknown>;
      expect(recorded.studioPaths).toEqual(['.env.studio']);
      writeFileSync(runFile, JSON.stringify({ ...recorded, studioPaths: [] }));
      agentWrites(prepared, { '.env.studio': 'API_KEY=placed-by-studio\n', 'pages.ts': 'x\n' });

      await finish(run, prepared);

      expect(
        git(bare(), ['ls-tree', '-r', '--name-only', `refs/heads/${prepared.runBranch}`], env),
      ).toBe('README.md\npages.ts');
    });
  });

  it('finds the Working copy and the kept result for a retry, and says when it is gone', async () => {
    const run = payload();
    const prepared = await prepare(run);
    await deliveries().commit(prepared, run, DONE, signal());

    const located = await deliveries().locate({
      ...run,
      kind: 'deliver',
      runBranch: prepared.runBranch,
    });
    expect(located.prepared).toEqual(prepared);
    expect(located.result).toEqual(DONE);

    rmSync(prepared.repoDir, { recursive: true, force: true });
    const error = await deliveries()
      .locate({ ...run, kind: 'deliver', runBranch: prepared.runBranch })
      .catch((caught: unknown) => caught);
    expect((error as DeliveryFailedError).detail).toMatch(new RegExp(`^${NO_WORKING_COPY}`));
  });
});
