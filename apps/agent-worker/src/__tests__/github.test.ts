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
});
