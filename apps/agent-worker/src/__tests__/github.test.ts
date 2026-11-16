import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubPullRequests, parseGitHubRemote, PullRequestFailedError } from '../github.js';
import { type StubGitHub, startStubGitHub } from './fixtures/stub-github.js';

// Issue #102: the Agent account's side of GitHub. The remote names the repository; the pull
// request client talks to a local stub of the REST API, never to real GitHub.

describe('parseGitHubRemote', () => {
  it('reads owner and repository from the https and SSH forms of a GitHub remote', () => {
    const shop = { owner: 'acme', repo: 'shop' };

    expect(parseGitHubRemote('https://github.com/acme/shop.git', false)).toEqual({
      ...shop,
      transport: 'https',
    });
    expect(parseGitHubRemote('https://github.com/acme/shop', false)).toEqual({
      ...shop,
      transport: 'https',
    });
    expect(parseGitHubRemote('https://GitHub.com/acme/shop/', false)).toEqual({
      ...shop,
      transport: 'https',
    });
    expect(parseGitHubRemote('git@github.com:acme/shop.git', false)).toEqual({
      ...shop,
      transport: 'ssh',
    });
    expect(parseGitHubRemote('ssh://git@github.com/acme/shop.git', false)).toEqual({
      ...shop,
      transport: 'ssh',
    });
    expect(parseGitHubRemote('ssh://git@github.com:22/acme/my.repo_1-x', false)).toEqual({
      owner: 'acme',
      repo: 'my.repo_1-x',
      transport: 'ssh',
    });
  });

  it('refuses any other host, and malformed owners or repositories', () => {
    expect(parseGitHubRemote('https://gitlab.com/acme/shop.git', false)).toBeNull();
    expect(parseGitHubRemote('git@bitbucket.org:acme/shop.git', false)).toBeNull();
    expect(parseGitHubRemote('https://github.com.evil.test/acme/shop.git', false)).toBeNull();
    expect(parseGitHubRemote('https://user:pw@github.com/acme/shop.git', false)).toBeNull();
    expect(parseGitHubRemote('https://github.com/acme/shop/extra.git', false)).toBeNull();
    expect(parseGitHubRemote('https://github.com/acme', false)).toBeNull();
    expect(parseGitHubRemote('https://github.com/-acme/shop.git', false)).toBeNull();
    expect(parseGitHubRemote('https://github.com/acme/..', false)).toBeNull();
    expect(parseGitHubRemote('http://github.com/acme/shop.git', false)).toBeNull();
  });

  it('treats a file:// fixture remote as owner/repo from its last two path parts, outside production only', () => {
    expect(parseGitHubRemote('file:///tmp/fixtures/acme/shop.git', true)).toEqual({
      owner: 'acme',
      repo: 'shop',
      transport: 'file',
    });
    expect(parseGitHubRemote('file:///tmp/fixtures/acme/shop.git', false)).toBeNull();
  });
});

describe('GitHubPullRequests', () => {
  let stub: StubGitHub;
  // A throwaway value generated per run; never a real token.
  const token = `ghp_${randomBytes(18).toString('hex')}`;
  const target = {
    owner: 'acme',
    repo: 'shop',
    head: 'agent/add-pagination-r0b8e5c2d',
    base: 'dev',
    title: 'Add pagination',
    body: 'Pages of 20.',
  };

  beforeEach(async () => {
    stub = await startStubGitHub();
  });
  afterEach(() => stub.close());

  const client = () => new GitHubPullRequests({ apiUrl: stub.url, token });

  it('opens a draft pull request against the base branch as the Agent account', async () => {
    const opened = await client().openDraft(target, new AbortController().signal);

    expect(opened).toEqual({
      url: `https://github.com/acme/shop/pull/1`,
      number: 1,
      reused: false,
    });
    expect(stub.created).toEqual([
      {
        owner: 'acme',
        repo: 'shop',
        body: {
          title: 'Add pagination',
          body: 'Pages of 20.',
          head: target.head,
          base: 'dev',
          draft: true,
        },
      },
    ]);
    expect(stub.requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(
      true,
    );
  });

  it('reuses the open pull request of the Run branch instead of opening a second one', async () => {
    stub.pullRequests.push({ owner: 'acme', repo: 'shop', head: target.head, number: 41 });

    const opened = await client().openDraft(target, new AbortController().signal);

    expect(opened).toEqual({
      url: 'https://github.com/acme/shop/pull/41',
      number: 41,
      reused: true,
    });
    expect(stub.created).toEqual([]);
    expect(stub.requests[0]?.query).toMatchObject({ state: 'open', head: `acme:${target.head}` });
  });

  it('says what to check when GitHub refuses, without the token', async () => {
    stub.failCreate = 403;

    const error = await client()
      .openDraft(target, new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PullRequestFailedError);
    expect((error as Error).message).toMatch(/GitHub answered 403/);
    expect((error as Error).message).toMatch(/Agent account/);
    expect((error as Error).message).not.toContain(token);
  });

  it('says GitHub could not be reached when the API is down', async () => {
    await stub.close();

    const error = await client()
      .openDraft(target, new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PullRequestFailedError);
    expect((error as Error).message).toMatch(/could not be reached/);
  });

  it('refuses an answer that is not a pull request it can link to', async () => {
    stub.htmlUrl = () => 'javascript:alert(1)';

    const error = await client()
      .openDraft(target, new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PullRequestFailedError);
  });

  describe('one pull request by number (Issue #141)', () => {
    const pull = { owner: 'acme', repo: 'shop', number: 41 };
    const signal = () => new AbortController().signal;

    it('reads its state: open, closed or merged', async () => {
      stub.pullRequests.push({ owner: 'acme', repo: 'shop', head: target.head, number: 41 });

      expect(await client().get(pull, signal())).toEqual({
        url: 'https://github.com/acme/shop/pull/41',
        number: 41,
        state: 'open',
        merged: false,
      });
      stub.pullRequests[0]!.state = 'closed';
      stub.pullRequests[0]!.merged = true;
      expect(await client().get(pull, signal())).toMatchObject({ state: 'closed', merged: true });
      expect(stub.requests.at(-1)).toMatchObject({
        method: 'GET',
        path: '/repos/acme/shop/pulls/41',
        authorization: `Bearer ${token}`,
      });
    });

    it('replaces its title and description', async () => {
      stub.pullRequests.push({ owner: 'acme', repo: 'shop', head: target.head, number: 41 });

      await client().update({ ...pull, title: 'New title', body: 'New body' }, signal());

      expect(stub.updated).toEqual([
        { owner: 'acme', repo: 'shop', number: 41, body: { title: 'New title', body: 'New body' } },
      ]);
      expect(stub.created).toEqual([]);
    });

    it('says what to check when GitHub refuses, without the token', async () => {
      const read = await client()
        .get(pull, signal())
        .catch((caught: unknown) => caught);
      expect(read).toBeInstanceOf(PullRequestFailedError);
      expect((read as Error).message).toMatch(
        /Reading the run's pull request failed: GitHub answered 404/,
      );

      const updated = await client()
        .update({ ...pull, title: 't', body: 'b' }, signal())
        .catch((caught: unknown) => caught);
      expect((updated as Error).message).toMatch(/Updating the run's pull request failed/);
      expect((updated as Error).message).not.toContain(token);
    });
  });

  // Issue #142: the reads a pull request lookup makes.
  describe('reads for a lookup (Issue #142)', () => {
    const pull = { owner: 'acme', repo: 'shop', number: 41 };
    const signal = () => new AbortController().signal;
    const branch = 'agent/add-pagination-r0b8e5c2d';

    it('reads a pull request with its branch, its author, its draft and merge state', async () => {
      stub.pullRequests.push({
        owner: 'acme',
        repo: 'shop',
        head: branch,
        number: 41,
        draft: true,
        mergeable: true,
      });

      expect(await client().details(pull, signal())).toEqual({
        url: 'https://github.com/acme/shop/pull/41',
        number: 41,
        state: 'open',
        merged: false,
        draft: true,
        mergeable: true,
        headRef: branch,
        headRepository: 'acme/shop',
        headSha: 'c'.repeat(40),
        author: 'agent-bot',
      });
      stub.pullRequests[0]!.mergeable = undefined;
      expect(await client().details(pull, signal())).toMatchObject({ mergeable: null });
    });

    it('reads how far a branch is behind and ahead of the base; a missing branch is null', async () => {
      stub.position = { behindBy: 3, aheadBy: 5 };

      const repository = { owner: 'acme', repo: 'shop' };
      expect(await client().position(repository, 'dev', branch, signal())).toEqual({
        behindBy: 3,
        aheadBy: 5,
      });
      expect(stub.requests.at(-1)?.path).toBe(`/repos/acme/shop/compare/dev...${branch}`);
      stub.missingBranches.push(branch);
      expect(await client().position(repository, 'dev', branch, signal())).toBeNull();
    });

    it('tells whether a branch exists (review S3 of #152)', async () => {
      const repository = { owner: 'acme', repo: 'shop' };

      expect(await client().branchExists(repository, branch, signal())).toBe(true);
      expect(stub.requests.at(-1)?.path).toBe(`/repos/acme/shop/branches/${branch}`);
      stub.missingBranches.push(branch);
      expect(await client().branchExists(repository, branch, signal())).toBe(false);
    });

    it('reads who the Agent account is', async () => {
      expect(await client().viewer(signal())).toBe('agent-bot');
      expect(stub.requests.at(-1)).toMatchObject({
        path: '/user',
        authorization: `Bearer ${token}`,
      });
    });

    it('reads only: every request of a lookup is a GET', async () => {
      stub.pullRequests.push({ owner: 'acme', repo: 'shop', head: branch, number: 41 });

      await client().details(pull, signal());
      await client().position({ owner: 'acme', repo: 'shop' }, 'dev', branch, signal());
      await client().viewer(signal());

      expect(stub.requests.map((request) => request.method)).toEqual(['GET', 'GET', 'GET']);
    });

    it('says how long GitHub asks to wait when it refuses for a rate limit', async () => {
      stub.pullRequests.push({ owner: 'acme', repo: 'shop', head: branch, number: 41 });

      stub.refuseNextRead = { status: 429, headers: { 'retry-after': '90' } };
      const retryAfter = await client()
        .details(pull, signal())
        .catch((error: unknown) => error);
      expect(retryAfter).toBeInstanceOf(PullRequestFailedError);
      expect(retryAfter).toMatchObject({ status: 429, retryAfterSeconds: 90 });
      expect((retryAfter as Error).message).not.toContain(token);

      stub.refuseNextRead = {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120),
        },
      };
      const reset = await client()
        .details(pull, signal())
        .catch((error: unknown) => error);
      expect((reset as PullRequestFailedError).retryAfterSeconds).toBeGreaterThanOrEqual(118);
      expect((reset as PullRequestFailedError).retryAfterSeconds).toBeLessThanOrEqual(121);

      // A plain refusal is not a rate limit.
      stub.refuseNextRead = { status: 403 };
      const refused = await client()
        .details(pull, signal())
        .catch((error: unknown) => error);
      expect(refused).toMatchObject({ status: 403 });
      expect((refused as PullRequestFailedError).retryAfterSeconds).toBeUndefined();
    });

    it('answers a pull request that does not exist with the status GitHub gave', async () => {
      const bad = await client()
        .details({ ...pull, number: 99 }, signal())
        .catch((e: unknown) => e);
      expect(bad).toMatchObject({ status: 404 });
    });
  });

  // Issue #145: the checks of a commit and the log of an Actions job.
  describe('checks and job logs (Issue #145)', () => {
    const repository = { owner: 'acme', repo: 'shop' };
    const signal = () => new AbortController().signal;
    const sha = 'c'.repeat(40);
    const fallback = 'https://github.com/acme/shop/pull/41/checks';
    const run = (overrides: Record<string, unknown> = {}) => ({
      id: 100,
      name: 'build',
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-11-16T10:00:00Z',
      completed_at: '2026-11-16T10:01:05Z',
      html_url: 'https://github.com/acme/shop/runs/100',
      app: { slug: 'github-actions' },
      output: { summary: null },
      ...overrides,
    });

    it('maps check runs and commit statuses to the check states, with durations and links', async () => {
      stub.checkRuns.push(
        run(),
        run({ id: 101, name: 'lint', conclusion: 'failure', output: { summary: 'Two problems' } }),
        run({ id: 102, name: 'queued job', status: 'queued', conclusion: null }),
        run({ id: 103, name: 'waiting', status: 'waiting', conclusion: null }),
        run({ id: 104, name: 'running job', status: 'in_progress', conclusion: null }),
        run({ id: 105, name: 'optional', conclusion: 'skipped' }),
        run({ id: 106, name: 'neutral', conclusion: 'neutral' }),
        run({ id: 107, name: 'stopped', conclusion: 'cancelled' }),
        run({ id: 108, name: 'too slow', conclusion: 'timed_out' }),
        run({ id: 109, name: 'external', app: { slug: 'circleci' }, html_url: null }),
        run({ id: 110, name: 'old run', conclusion: 'stale' }),
        run({ id: 111, name: 'needs approval', conclusion: 'action_required' }),
        run({ id: 112, name: 'secret link', html_url: 'https://user:token@ci.test/x' }),
      );
      stub.statuses.push(
        { context: 'ci/legacy', state: 'success', target_url: 'https://ci.example.test/1' },
        { context: 'ci/pending', state: 'pending', target_url: 'javascript:alert(1)' },
        { context: 'ci/broken', state: 'error', description: 'It broke' },
      );

      const checks = await client().checks(repository, sha, fallback, signal());

      expect(checks.map(({ name, state }) => [name, state])).toEqual([
        ['build', 'passed'],
        ['lint', 'failed'],
        ['queued job', 'queued'],
        ['waiting', 'queued'],
        ['running job', 'running'],
        ['optional', 'skipped'],
        ['neutral', 'skipped'],
        ['stopped', 'cancelled'],
        ['too slow', 'failed'],
        ['external', 'passed'],
        ['old run', 'skipped'],
        ['needs approval', 'failed'],
        ['secret link', 'passed'],
        ['ci/legacy', 'passed'],
        ['ci/pending', 'running'],
        ['ci/broken', 'failed'],
      ]);
      expect(checks[0]).toEqual({
        name: 'build',
        state: 'passed',
        durationSeconds: 65,
        url: 'https://github.com/acme/shop/runs/100',
        jobId: 100,
      });
      expect(checks[1]).toMatchObject({ jobId: 101, summary: 'Two problems' });
      // A check without a link of its own, or with one that is not a web link, gets the fallback.
      expect(checks[9]).toMatchObject({ url: fallback });
      expect(checks[9]).not.toHaveProperty('jobId');
      expect(checks[14]).toMatchObject({ url: fallback });
      expect(checks[15]).toMatchObject({ summary: 'It broke' });
      expect(stub.requests.at(-2)).toMatchObject({
        path: `/repos/acme/shop/commits/${sha}/check-runs`,
        query: { per_page: '100' },
        authorization: `Bearer ${token}`,
      });
    });

    it('reads the end of a job log from the download GitHub redirects to, never sending the token there', async () => {
      stub.jobLogs.set(100, { text: 'step 1\nstep 2\nerror: boom\n' });

      const outcome = await client().jobLog(repository, 100, signal());

      expect(outcome).toEqual({ log: 'step 1\nstep 2\nerror: boom\n' });
      expect(stub.requests.at(-1)).toMatchObject({
        path: '/__logs/100',
        authorization: undefined,
      });
      expect(stub.requests.at(-2)).toMatchObject({ authorization: `Bearer ${token}` });
    });

    it('keeps only the end of a very long log', async () => {
      stub.jobLogs.set(100, { text: `${'a'.repeat(2_000_000)}\nthe end\n` });

      const outcome = await client().jobLog(repository, 100, signal());

      expect('log' in outcome && outcome.log.length).toBeLessThanOrEqual(256 * 1024);
      expect('log' in outcome && outcome.log.endsWith('the end\n')).toBe(true);
    });

    it.each([
      [404, 'cannot read the log, or it was removed'],
      [403, 'cannot read the log, or it was removed'],
      [410, 'has expired'],
    ])('says why there is no log when GitHub answers %i', async (status, reason) => {
      stub.jobLogs.set(100, { status });

      const outcome = await client().jobLog(repository, 100, signal());

      expect(outcome).toEqual({ unavailable: expect.stringContaining(reason) });
    });

    it('leaves a link with credentials out, using the fallback', async () => {
      stub.checkRuns.push(run({ html_url: 'https://user:token@ci.test/x', details_url: null }));

      const [only] = await client().checks(repository, sha, fallback, signal());

      expect(only?.url).toBe(fallback);
    });

    it('does not follow a redirect to another host over http, a missing address or a strange scheme', async () => {
      const follow = async (location: string | null) => {
        const requests: string[] = [];
        const fake = new GitHubPullRequests({
          apiUrl: 'https://api.example.test',
          token,
          fetch: (async (input: unknown) => {
            requests.push(String(input));
            return new Response(null, {
              status: 302,
              headers: location === null ? {} : { Location: location },
            });
          }) as typeof fetch,
        });
        const outcome = await fake.jobLog(repository, 100, signal());
        return { outcome, requests };
      };

      for (const location of [
        null,
        'http://evil.example/log',
        'file:///etc/passwd',
        'javascript:alert(1)',
      ]) {
        const { outcome, requests } = await follow(location);
        expect(outcome).toEqual({ unavailable: expect.stringContaining('no usable address') });
        // Only the API call was made: nothing went to the foreign address.
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatch(/^https:\/\/api\.example\.test\//);
      }
    });

    it('still reports a rate limit on a log as a refusal to wait out', async () => {
      stub.refuseNextRead = { status: 429, headers: { 'retry-after': '30' } };

      const error = await client()
        .jobLog(repository, 100, signal())
        .catch((e: unknown) => e);

      expect(error).toMatchObject({ status: 429, retryAfterSeconds: 30 });
    });
  });
});
