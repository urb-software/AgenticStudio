import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { MergeCredential } from '../../../../../platform/config/merge-credential.js';
import type { PullRequestScope } from '../../../application/ports/merge-host.js';
import { GitHubMergeHost } from '../github-merge-host.js';

const TOKEN = `fake-${randomBytes(18).toString('hex')}`;
const API = 'https://api.example.test';
const BRANCH = 'agent/add-login-r1a2b3c4d';
const SHA = 'b'.repeat(40);
const SCOPE: PullRequestScope = {
  remoteUrl: 'https://github.com/acme/shop.git',
  runId: '1a2b3c4d-0000-4000-8000-000000000000',
  integrationBranch: 'dev',
  runBranch: BRANCH,
  pullRequestNumber: 7,
};

/** What GitHub answers for `GET /repos/acme/shop/pulls/7`, recorded and trimmed. */
function pullRequestAnswer(overrides: Record<string, unknown> = {}) {
  return {
    node_id: 'PR_kwDOfake',
    state: 'open',
    merged: false,
    draft: false,
    mergeable: true,
    mergeable_state: 'clean',
    head: { sha: SHA, ref: BRANCH, repo: { full_name: 'acme/shop' } },
    base: { ref: 'dev', repo: { full_name: 'acme/shop' } },
    ...overrides,
  };
}

interface Recorded {
  method: string;
  path: string;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
  body: unknown;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fake `fetch`: the first matching `METHOD path` route answers, an unknown route is a test bug. */
function fakeHost(routes: Record<string, Reply | Reply[]>) {
  const requests: Recorded[] = [];
  const queues = new Map(
    Object.entries(routes).map(([key, reply]) => [
      key,
      Array.isArray(reply) ? [...reply] : [reply],
    ]),
  );
  const fetchFake = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      authorization: new Headers(init?.headers).get('authorization'),
      redirect: init?.redirect,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const queue = queues.get(`${method} ${url.pathname}${url.search}`);
    const reply = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    if (reply === undefined) throw new Error(`unexpected request ${method} ${url.pathname}`);
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.headers,
    });
  };
  return { requests, fetch: fetchFake as typeof fetch };
}

function hostWith(routes: Record<string, Reply | Reply[]>, token: string | null = TOKEN) {
  const fake = fakeHost(routes);
  const host = new GitHubMergeHost({
    credential: token === null ? null : MergeCredential.of(token),
    apiUrl: API,
    fetch: fake.fetch,
    now: () => Date.UTC(2026, 10, 21, 12, 0, 0),
  });
  return { host, requests: fake.requests };
}

const PULL = 'GET /repos/acme/shop/pulls/7';
const OPEN: Reply = { status: 200, body: pullRequestAnswer() };

describe('GitHubMergeHost', () => {
  describe('readPullRequest', () => {
    it('answers the state, draft flag, head, base and mergeability of an open pull request', async () => {
      const { host } = hostWith({ [PULL]: OPEN });
      expect(await host.readPullRequest(SCOPE)).toEqual({
        ok: true,
        pullRequest: {
          state: 'open',
          draft: false,
          headSha: SHA,
          headRef: BRANCH,
          baseRef: 'dev',
          mergeable: true,
          mergeableState: 'clean',
        },
      });
    });

    it('answers merged for a closed pull request that was merged, and null while mergeable is unknown', async () => {
      const { host } = hostWith({
        [PULL]: {
          status: 200,
          body: pullRequestAnswer({ state: 'closed', merged: true, mergeable: null }),
        },
      });
      const answer = await host.readPullRequest(SCOPE);
      expect(answer).toMatchObject({
        ok: true,
        pullRequest: { state: 'merged', mergeable: null },
      });
    });

    it('answers closed for a pull request closed without a merge', async () => {
      const { host } = hostWith({
        [PULL]: { status: 200, body: pullRequestAnswer({ state: 'closed' }) },
      });
      expect(await host.readPullRequest(SCOPE)).toMatchObject({
        pullRequest: { state: 'closed' },
      });
    });

    it('sends the token only to the configured API, without following redirects', async () => {
      const { host, requests } = hostWith({ [PULL]: OPEN });
      await host.readPullRequest(SCOPE);
      expect(requests).toEqual([
        expect.objectContaining({
          path: '/repos/acme/shop/pulls/7',
          authorization: `Bearer ${TOKEN}`,
          redirect: 'manual',
        }),
      ]);
    });

    it('answers unavailable for a redirect instead of following it with the token', async () => {
      const { host, requests } = hostWith({
        [PULL]: { status: 301, headers: { location: 'https://elsewhere.test/x' } },
      });
      expect(await host.readPullRequest(SCOPE)).toEqual({
        ok: false,
        failure: { code: 'unavailable' },
      });
      expect(requests).toHaveLength(1);
    });
  });

  describe('failures', () => {
    it('answers not_configured without a call while the credential is unset', async () => {
      const { host, requests } = hostWith({}, null);
      expect(await host.merge(SCOPE, { sha: SHA, method: 'squash' })).toEqual({
        ok: false,
        failure: { code: 'not_configured' },
      });
      expect(await host.readPullRequest(SCOPE)).toEqual({
        ok: false,
        failure: { code: 'not_configured' },
      });
      expect(requests).toEqual([]);
    });

    it.each([
      'https://gitlab.com/acme/shop.git',
      'https://github.com.evil.test/acme/shop.git',
      'file:///srv/git/acme/shop.git',
    ])('answers unsupported_host without a call for %s', async (remoteUrl) => {
      const { host, requests } = hostWith({});
      expect(await host.close({ ...SCOPE, remoteUrl })).toEqual({
        ok: false,
        failure: { code: 'unsupported_host' },
      });
      expect(requests).toEqual([]);
    });

    it('answers not_found for a 404', async () => {
      const { host } = hostWith({ [PULL]: { status: 404, body: { message: 'Not Found' } } });
      expect(await host.readPullRequest(SCOPE)).toEqual({
        ok: false,
        failure: { code: 'not_found' },
      });
    });

    it('answers rate_limited with the seconds until the limit resets for a 403 with rate-limit headers', async () => {
      const reset = String(Date.UTC(2026, 10, 21, 12, 0, 0) / 1000 + 90);
      const { host } = hostWith({
        [PULL]: {
          status: 403,
          body: { message: 'API rate limit exceeded' },
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
        },
      });
      expect(await host.readPullRequest(SCOPE)).toEqual({
        ok: false,
        failure: { code: 'rate_limited', retryAfterSeconds: 90 },
      });
    });

    it('prefers Retry-After and answers rate_limited for a 429', async () => {
      const { host } = hostWith({
        [PULL]: { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '30' } },
      });
      expect(await host.readPullRequest(SCOPE)).toEqual({
        ok: false,
        failure: { code: 'rate_limited', retryAfterSeconds: 30 },
      });
    });

    it('answers rate_limited for a secondary rate limit: a 403 that names the rate limit without headers', async () => {
      const { host } = hostWith({
        [PULL]: {
          status: 403,
          body: { message: 'You have exceeded a secondary rate limit. Please wait.' },
        },
      });
      expect(await host.readPullRequest(SCOPE)).toEqual({
        ok: false,
        failure: { code: 'rate_limited', retryAfterSeconds: 60 },
      });
    });

    it('answers unavailable for an answer larger than 1 MiB', async () => {
      const big = new GitHubMergeHost({
        credential: MergeCredential.of(TOKEN),
        apiUrl: API,
        fetch: (async () =>
          new Response('x'.repeat(1024 * 1024 + 1), { status: 200 })) as typeof fetch,
      });
      expect(await big.readPullRequest(SCOPE)).toEqual({
        ok: false,
        failure: { code: 'unavailable' },
      });
    });

    it('answers refused, not rate_limited, for a 403 without rate-limit headers', async () => {
      const { host } = hostWith({
        [PULL]: {
          status: 403,
          body: { message: 'Resource not accessible by personal access token' },
        },
      });
      expect(await host.readPullRequest(SCOPE)).toEqual({
        ok: false,
        failure: { code: 'refused', message: 'Resource not accessible by personal access token' },
      });
    });

    it.each([500, 502, 503])('answers unavailable for a %i', async (status) => {
      const { host } = hostWith({ [PULL]: { status } });
      expect(await host.readPullRequest(SCOPE)).toEqual({
        ok: false,
        failure: { code: 'unavailable' },
      });
    });

    it('answers unavailable for a network error and for an answer it cannot read', async () => {
      const down = hostWith({ [PULL]: new TypeError('fetch failed') });
      expect(await down.host.readPullRequest(SCOPE)).toEqual({
        ok: false,
        failure: { code: 'unavailable' },
      });
      const odd = hostWith({ [PULL]: { status: 200, body: { unexpected: true } } });
      expect(await odd.host.readPullRequest(SCOPE)).toEqual({
        ok: false,
        failure: { code: 'unavailable' },
      });
    });

    it('never throws for a host error', async () => {
      const { host } = hostWith({ [PULL]: new Error('boom') });
      await expect(host.merge(SCOPE, { sha: SHA, method: 'squash' })).resolves.toMatchObject({
        ok: false,
      });
    });
  });

  describe('scope', () => {
    const sourceOf = (overrides: Record<string, unknown>) =>
      hostWith({ [PULL]: { status: 200, body: pullRequestAnswer(overrides) } });

    it.each([
      [
        'another head branch',
        { head: { sha: SHA, ref: 'agent/other-r99999999', repo: { full_name: 'acme/shop' } } },
      ],
      [
        'a head in a fork',
        { head: { sha: SHA, ref: BRANCH, repo: { full_name: 'mallory/shop' } } },
      ],
      ['a deleted head repository', { head: { sha: SHA, ref: BRANCH, repo: null } }],
      ['another base repository', { base: { ref: 'dev', repo: { full_name: 'acme/other' } } }],
    ])('answers scope_mismatch and writes nothing for %s', async (_name, overrides) => {
      const { host, requests } = sourceOf(overrides);
      for (const write of [
        () => host.markReady(SCOPE),
        () => host.approve(SCOPE, SHA),
        () => host.merge(SCOPE, { sha: SHA, method: 'squash' }),
        () => host.close(SCOPE),
        () => host.deleteRunBranch(SCOPE),
        () => host.readChecks(SCOPE, SHA),
      ]) {
        expect(await write()).toEqual({ ok: false, failure: { code: 'scope_mismatch' } });
      }
      expect(requests.every((request) => request.method === 'GET')).toBe(true);
    });

    it.each([
      'main',
      'agent/x-r1234',
      'agent/x-rGGGGGGGG',
      'agent/../main-r12345678',
      'agent/UPPER-r12345678',
      'feature/x-r12345678',
    ])('answers scope_mismatch without a call for the branch %s', async (runBranch) => {
      const { host, requests } = hostWith({});
      expect(await host.deleteRunBranch({ ...SCOPE, runBranch })).toEqual({
        ok: false,
        failure: { code: 'scope_mismatch' },
      });
      expect(requests).toEqual([]);
    });

    it.each([0, -1, 1.5, Number.NaN])(
      'answers scope_mismatch without a call for the pull request number %s',
      async (pullRequestNumber) => {
        const { host, requests } = hostWith({});
        expect(await host.close({ ...SCOPE, pullRequestNumber })).toEqual({
          ok: false,
          failure: { code: 'scope_mismatch' },
        });
        expect(requests).toEqual([]);
      },
    );

    it('answers scope_mismatch without a call for the well-formed branch of another Run', async () => {
      const { host, requests } = hostWith({});
      const other = { ...SCOPE, runBranch: 'agent/add-login-r99999999' };
      for (const call of [
        () => host.close(other),
        () => host.deleteRunBranch(other),
        () => host.merge(other, { sha: SHA, method: 'squash' }),
      ]) {
        expect(await call()).toEqual({ ok: false, failure: { code: 'scope_mismatch' } });
      }
      expect(requests).toEqual([]);
    });

    it('answers scope_mismatch without a call when the Run branch is the integration branch', async () => {
      const { host, requests } = hostWith({});
      const scope = { ...SCOPE, integrationBranch: BRANCH };
      expect(await host.close(scope)).toEqual({ ok: false, failure: { code: 'scope_mismatch' } });
      expect(requests).toEqual([]);
    });

    it('compares the repository name ignoring case', async () => {
      const { host } = hostWith({
        [PULL]: {
          status: 200,
          body: pullRequestAnswer({
            head: { sha: SHA, ref: BRANCH, repo: { full_name: 'Acme/Shop' } },
            base: { ref: 'dev', repo: { full_name: 'Acme/Shop' } },
          }),
        },
      });
      expect(await host.readPullRequest(SCOPE)).toMatchObject({ ok: true });
    });
  });

  describe('writes', () => {
    it('approves with a review pinned to the commit', async () => {
      const { host, requests } = hostWith({
        [PULL]: OPEN,
        'POST /repos/acme/shop/pulls/7/reviews': { status: 200, body: { id: 1 } },
      });
      expect(await host.approve(SCOPE, SHA)).toEqual({ ok: true });
      expect(requests.at(-1)?.body).toEqual({ event: 'APPROVE', commit_id: SHA });
    });

    it.each([
      ['squash', 'squash'],
      ['merge_commit', 'merge'],
    ] as const)(
      'merges with %s, sending the approved commit and the message',
      async (method, sent) => {
        const { host, requests } = hostWith({
          [PULL]: OPEN,
          'PUT /repos/acme/shop/pulls/7/merge': {
            status: 200,
            body: {
              merged: true,
              sha: 'c'.repeat(40),
              message: 'Pull Request successfully merged',
            },
          },
        });
        expect(
          await host.merge(SCOPE, { sha: SHA, method, title: 'Add login (#7)', message: 'Body' }),
        ).toEqual({
          ok: true,
        });
        expect(requests.at(-1)?.body).toEqual({
          sha: SHA,
          merge_method: sent,
          commit_title: 'Add login (#7)',
          commit_message: 'Body',
        });
      },
    );

    it('leaves out the title and message when none is given', async () => {
      const { host, requests } = hostWith({
        [PULL]: OPEN,
        'PUT /repos/acme/shop/pulls/7/merge': { status: 200, body: { merged: true } },
      });
      await host.merge(SCOPE, { sha: SHA, method: 'squash' });
      expect(requests.at(-1)?.body).toEqual({ sha: SHA, merge_method: 'squash' });
    });

    it.each([
      [405, 'Pull Request is not mergeable'],
      [409, 'Head branch was modified. Review and try the merge again.'],
      [422, 'Validation Failed'],
    ])('answers refused with the host message for a %i merge answer', async (status, message) => {
      const { host } = hostWith({
        [PULL]: OPEN,
        'PUT /repos/acme/shop/pulls/7/merge': { status, body: { message } },
      });
      expect(await host.merge(SCOPE, { sha: SHA, method: 'squash' })).toEqual({
        ok: false,
        failure: { code: 'refused', message },
      });
    });

    it('adds the error texts of a 422 to the refusal', async () => {
      const { host } = hostWith({
        [PULL]: OPEN,
        'PATCH /repos/acme/shop/pulls/7': {
          status: 422,
          body: {
            message: 'Validation Failed',
            errors: [{ message: 'state is invalid' }, 'also bad'],
          },
        },
      });
      expect(await host.close(SCOPE)).toEqual({
        ok: false,
        failure: { code: 'refused', message: 'Validation Failed state is invalid also bad' },
      });
    });

    it('refuses a merge the host answers 200 without merging', async () => {
      const { host } = hostWith({
        [PULL]: OPEN,
        'PUT /repos/acme/shop/pulls/7/merge': { status: 200, body: { merged: false } },
      });
      expect(await host.merge(SCOPE, { sha: SHA, method: 'squash' })).toMatchObject({
        ok: false,
        failure: { code: 'refused' },
      });
    });

    it.each(['abc1234', 'b'.repeat(39), 'b'.repeat(41), 'g'.repeat(40)])(
      'refuses the short or malformed commit id %s for every pinned call',
      async (sha) => {
        const { host, requests } = hostWith({ [PULL]: OPEN });
        for (const call of [
          () => host.approve(SCOPE, sha),
          () => host.merge(SCOPE, { sha, method: 'squash' }),
          () => host.readChecks(SCOPE, sha),
        ]) {
          expect(await call()).toMatchObject({ ok: false, failure: { code: 'refused' } });
        }
        expect(requests.every((request) => request.method === 'GET')).toBe(true);
      },
    );

    it('accepts a full 64-digit commit id', async () => {
      const long = 'b'.repeat(64);
      const { host } = hostWith({
        [PULL]: OPEN,
        'POST /repos/acme/shop/pulls/7/reviews': { status: 200, body: {} },
      });
      expect(await host.approve(SCOPE, long)).toEqual({ ok: true });
    });

    it('refuses a commit that is not a commit id without writing', async () => {
      const { host, requests } = hostWith({ [PULL]: OPEN });
      expect(await host.merge(SCOPE, { sha: '../../x', method: 'squash' })).toMatchObject({
        failure: { code: 'refused' },
      });
      expect(requests.every((request) => request.method === 'GET')).toBe(true);
    });

    it('closes the pull request without merging', async () => {
      const { host, requests } = hostWith({
        [PULL]: OPEN,
        'PATCH /repos/acme/shop/pulls/7': { status: 200, body: { state: 'closed' } },
      });
      expect(await host.close(SCOPE)).toEqual({ ok: true });
      expect(requests.at(-1)).toMatchObject({ method: 'PATCH', body: { state: 'closed' } });
    });

    it('deletes only the Run branch, and only after reading the pull request', async () => {
      const { host, requests } = hostWith({
        [PULL]: OPEN,
        [`DELETE /repos/acme/shop/git/refs/heads/${BRANCH}`]: { status: 204 },
      });
      expect(await host.deleteRunBranch(SCOPE)).toEqual({ ok: true });
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        'GET /repos/acme/shop/pulls/7',
        `DELETE /repos/acme/shop/git/refs/heads/${BRANCH}`,
      ]);
    });

    it('marks a draft ready through the GraphQL API and skips the call for a ready pull request', async () => {
      const draft = hostWith({
        [PULL]: { status: 200, body: pullRequestAnswer({ draft: true }) },
        'POST /graphql': { status: 200, body: { data: { markPullRequestReadyForReview: {} } } },
      });
      expect(await draft.host.markReady(SCOPE)).toEqual({ ok: true });
      expect(draft.requests.at(-1)).toMatchObject({
        method: 'POST',
        body: { variables: { id: 'PR_kwDOfake' } },
      });
      const ready = hostWith({ [PULL]: OPEN });
      expect(await ready.host.markReady(SCOPE)).toEqual({ ok: true });
      expect(ready.requests).toHaveLength(1);
    });

    it('answers refused when the GraphQL API reports errors', async () => {
      const { host } = hostWith({
        [PULL]: { status: 200, body: pullRequestAnswer({ draft: true }) },
        'POST /graphql': {
          status: 200,
          body: { errors: [{ message: 'Not allowed to mark ready' }] },
        },
      });
      expect(await host.markReady(SCOPE)).toEqual({
        ok: false,
        failure: { code: 'refused', message: 'Not allowed to mark ready' },
      });
    });
  });

  describe('readChecks', () => {
    const RUNS = `GET /repos/acme/shop/commits/${SHA}/check-runs?per_page=100&page=1`;
    const STATUS = `GET /repos/acme/shop/commits/${SHA}/status?per_page=100&page=1`;

    it('merges check runs and commit statuses into one list', async () => {
      const { host } = hostWith({
        [PULL]: OPEN,
        [RUNS]: {
          status: 200,
          body: {
            total_count: 5,
            check_runs: [
              { name: 'build', status: 'completed', conclusion: 'success' },
              { name: 'lint', status: 'completed', conclusion: 'failure' },
              { name: 'e2e', status: 'in_progress', conclusion: null },
              { name: 'docs', status: 'completed', conclusion: 'skipped' },
              { name: 'sec', status: 'completed', conclusion: 'cancelled' },
            ],
          },
        },
        [STATUS]: {
          status: 200,
          body: {
            state: 'failure',
            total_count: 3,
            statuses: [
              { context: 'ci/legacy', state: 'success' },
              { context: 'ci/other', state: 'pending' },
              { context: 'ci/old', state: 'error' },
            ],
          },
        },
      });
      expect(await host.readChecks(SCOPE, SHA)).toEqual({
        ok: true,
        checks: [
          { name: 'build', state: 'success' },
          { name: 'lint', state: 'failure' },
          { name: 'e2e', state: 'pending' },
          { name: 'docs', state: 'neutral' },
          { name: 'sec', state: 'failure' },
          { name: 'ci/legacy', state: 'success' },
          { name: 'ci/other', state: 'pending' },
          { name: 'ci/old', state: 'failure' },
        ],
      });
    });

    it('answers an empty list for a commit without checks', async () => {
      const { host } = hostWith({
        [PULL]: OPEN,
        [RUNS]: { status: 200, body: { total_count: 0, check_runs: [] } },
        [STATUS]: { status: 200, body: { state: 'pending', total_count: 0, statuses: [] } },
      });
      expect(await host.readChecks(SCOPE, SHA)).toEqual({ ok: true, checks: [] });
    });

    it('reads every page', async () => {
      const page = (from: number, count: number) => ({
        status: 200,
        body: {
          total_count: 150,
          check_runs: Array.from({ length: count }, (_, index) => ({
            name: `job-${from + index}`,
            status: 'completed',
            conclusion: 'success',
          })),
        },
      });
      const { host } = hostWith({
        [PULL]: OPEN,
        [RUNS]: page(0, 100),
        [`GET /repos/acme/shop/commits/${SHA}/check-runs?per_page=100&page=2`]: page(100, 50),
        [STATUS]: { status: 200, body: { statuses: [] } },
      });
      const answer = await host.readChecks(SCOPE, SHA);
      expect(answer.ok && answer.checks).toHaveLength(150);
    });

    it('answers unavailable instead of a partial list when the pages do not end', async () => {
      const endless = {
        status: 200,
        body: {
          total_count: 100_000,
          check_runs: Array.from({ length: 100 }, (_, index) => ({
            name: `job-${index}`,
            status: 'completed',
            conclusion: 'success',
          })),
        },
      };
      const routes: Record<string, Reply> = { [PULL]: OPEN };
      for (let page = 1; page <= 20; page += 1) {
        routes[`GET /repos/acme/shop/commits/${SHA}/check-runs?per_page=100&page=${page}`] =
          endless;
      }
      const { host } = hostWith(routes);
      expect(await host.readChecks(SCOPE, SHA)).toEqual({
        ok: false,
        failure: { code: 'unavailable' },
      });
    });
  });

  describe('the token never leaves the adapter', () => {
    it('redacts a host error that echoes the token', async () => {
      const { host } = hostWith({
        [PULL]: OPEN,
        'PUT /repos/acme/shop/pulls/7/merge': {
          status: 422,
          body: { message: `Bad value ${TOKEN} for token, got ${TOKEN}` },
        },
      });
      const answer = await host.merge(SCOPE, { sha: SHA, method: 'squash' });
      expect(JSON.stringify(answer)).not.toContain(TOKEN);
      expect(answer).toMatchObject({ failure: { code: 'refused' } });
    });

    it('redacts a token echoed in a body that is not JSON, and a bearer header', async () => {
      const { host } = hostWith({
        [PULL]: {
          status: 400,
          body: undefined,
        },
      });
      const plain = new GitHubMergeHost({
        credential: MergeCredential.of(TOKEN),
        apiUrl: API,
        fetch: (async () =>
          new Response(`oops Authorization: Bearer ${TOKEN} and ${TOKEN}`, {
            status: 400,
          })) as typeof fetch,
      });
      expect(JSON.stringify(await plain.readPullRequest(SCOPE))).not.toContain(TOKEN);
      expect(JSON.stringify(await host.readPullRequest(SCOPE))).not.toContain(TOKEN);
    });

    it('writes nothing to the process output, whatever the host answers', async () => {
      const written: string[] = [];
      const capture = (chunk: unknown) => {
        written.push(String(chunk));
        return true;
      };
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
      const log = vi.spyOn(console, 'log').mockImplementation((...args) => void capture(args));
      const error = vi.spyOn(console, 'error').mockImplementation((...args) => void capture(args));
      try {
        const { host } = hostWith({
          [PULL]: [
            { status: 401, body: { message: `Bad credentials ${TOKEN}` } },
            new TypeError(`fetch failed ${TOKEN}`),
            { status: 500, body: { message: TOKEN } },
          ],
        });
        for (let call = 0; call < 3; call += 1) await host.close(SCOPE);
      } finally {
        out.mockRestore();
        err.mockRestore();
        log.mockRestore();
        error.mockRestore();
      }
      expect(written.join('')).not.toContain(TOKEN);
    });

    it('does not print the token when the adapter itself is inspected or serialized', () => {
      const { host } = hostWith({});
      expect(inspect(host, { depth: null, showHidden: true })).not.toContain(TOKEN);
      expect(JSON.stringify(host)).not.toContain(TOKEN);
    });

    it('cuts a refusal message to 500 characters', async () => {
      const { host } = hostWith({
        [PULL]: { status: 422, body: { message: 'x'.repeat(2000) } },
      });
      const answer = await host.readPullRequest(SCOPE);
      expect(!answer.ok && answer.failure.code === 'refused' && answer.failure.message.length).toBe(
        500,
      );
    });
  });
});
