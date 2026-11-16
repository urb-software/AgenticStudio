import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Issue #102: a local stub of the two GitHub REST routes the worker uses (list open pull
// requests of a branch, create one). Tests and the e2e smoke point STUDIO_AGENT_GITHUB_API_URL
// at it; nothing reaches real GitHub.

export interface StubPullRequest {
  owner: string;
  repo: string;
  head: string;
  number: number;
  /** Issue #141: `closed` (and `merged`) leaves it out of the open pull requests of its branch. */
  state?: 'open' | 'closed';
  merged?: boolean;
  /** Issue #142: a draft pull request (default: not a draft). */
  draft?: boolean;
  /** Issue #142: GitHub's merge verdict (default `null`: not worked out yet). */
  mergeable?: boolean | null;
  /** Issue #142: who opened it (default: the stub's Agent account). */
  author?: string;
  /** Issue #142: `owner/repo` of the head branch (default: the pull request's own repository). */
  headRepository?: string | null;
  /** Issue #145: the pull request's latest commit (default: forty `c`). */
  headSha?: string;
  title?: string;
  body?: string;
}

export interface StubRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | undefined;
}

export interface StubGitHub {
  url: string;
  /** Every request, in order. */
  requests: StubRequest[];
  /** The open pull requests (a created one is added). */
  pullRequests: StubPullRequest[];
  /** The bodies of created pull requests. */
  created: { owner: string; repo: string; body: Record<string, unknown> }[];
  /** The bodies of pull request updates (PATCH, Issue #141), with the number. */
  updated: { owner: string; repo: string; number: number; body: Record<string, unknown> }[];
  /** When set, creating a pull request answers this status (once per value set). */
  failCreate: number | undefined;
  /** When set, updating a pull request answers this status (once per value set; Issue #141). */
  failUpdate: number | undefined;
  /** Issue #142: the login of the Agent account (`GET /user`). */
  viewer: string;
  /** Issue #142: what `GET /compare/...` answers (default: 0 behind, 1 ahead). */
  position: { behindBy: number; aheadBy: number };
  /** Issue #142: head branches that no longer exist (compare answers 404). */
  missingBranches: string[];
  /**
   * Issue #142: when set, the next read (`GET`) is refused with this status and these headers,
   * once (a rate limit, or any refusal).
   */
  refuseNextRead: { status: number; headers?: Record<string, string> } | undefined;
  /** Issue #145: the check runs `GET /commits/:sha/check-runs` answers, as GitHub words them. */
  checkRuns: Record<string, unknown>[];
  /** Issue #145: the commit statuses `GET /commits/:sha/status` answers. */
  statuses: Record<string, unknown>[];
  /**
   * Issue #145: what `GET /actions/jobs/:id/logs` does for a job: redirect to a download of
   * `text` (as GitHub does), or answer a refusal status.
   */
  jobLogs: Map<number, { text: string } | { status: number }>;
  /** Issue #146: what `GET /pulls/:n/reviews` answers, as GitHub words it. */
  reviews: Record<string, unknown>[];
  /** Issue #146: what `GET /pulls/:n/comments` (inline comments) answers. */
  inlineComments: Record<string, unknown>[];
  /** Issue #146: what `GET /issues/:n/comments` (conversation comments) answers. */
  issueComments: Record<string, unknown>[];
  /** Issue #146: the review threads the GraphQL query answers: resolved or not, comment ids. */
  reviewThreads: { isResolved: boolean; commentIds: number[]; moreComments?: boolean }[];
  /** Issue #146: leave out the `Link` header of the comment listings (a proxy that drops it). */
  omitLinkHeader: boolean;
  /** Issue #146: when set, the GraphQL query answers these errors (with status 200). */
  graphqlErrors: unknown[] | undefined;
  /** The `html_url` of a pull request (default: its github.com URL). */
  htmlUrl: (pr: StubPullRequest) => string;
  close(): Promise<void>;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return JSON.parse(text || '{}') as Record<string, unknown>;
}

export async function startStubGitHub(): Promise<StubGitHub> {
  const stub: Omit<StubGitHub, 'url' | 'close'> = {
    requests: [],
    pullRequests: [],
    created: [],
    updated: [],
    failCreate: undefined,
    failUpdate: undefined,
    viewer: 'agent-bot',
    position: { behindBy: 0, aheadBy: 1 },
    missingBranches: [],
    refuseNextRead: undefined,
    checkRuns: [],
    statuses: [],
    jobLogs: new Map(),
    reviews: [],
    inlineComments: [],
    issueComments: [],
    reviewThreads: [],
    graphqlErrors: undefined,
    omitLinkHeader: false,
    htmlUrl: (pr) => `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
  };
  const view = (pr: StubPullRequest) => ({ number: pr.number, html_url: stub.htmlUrl(pr) });
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://stub');
      stub.requests.push({
        method: request.method ?? '',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        authorization: request.headers.authorization,
      });
      const match = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname);
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        response.end(JSON.stringify(body));
      };
      if (request.method === 'GET' && stub.refuseNextRead) {
        const refusal = stub.refuseNextRead;
        stub.refuseNextRead = undefined;
        return send(refusal.status, { message: 'Refused by the stub' }, refusal.headers);
      }
      // Issue #146: the comments of a pull request, a hundred to a page, and its review threads.
      const comments =
        /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/(reviews|comments)$/.exec(url.pathname) ??
        /^\/repos\/[^/]+\/[^/]+\/(issues)\/\d+\/comments$/.exec(url.pathname);
      if (request.method === 'GET' && comments) {
        const list =
          comments[1] === 'reviews'
            ? stub.reviews
            : comments[1] === 'comments'
              ? stub.inlineComments
              : stub.issueComments;
        const size = Number(url.searchParams.get('per_page') ?? 30);
        const page = Number(url.searchParams.get('page') ?? 1);
        const last = Math.max(1, Math.ceil(list.length / size));
        return send(
          200,
          list.slice((page - 1) * size, page * size),
          stub.omitLinkHeader
            ? {}
            : {
                Link: `<http://${request.headers.host}${url.pathname}?per_page=${size}&page=${last}>; rel="last"`,
              },
        );
      }
      if (request.method === 'POST' && url.pathname === '/graphql') {
        const body = await readJson(request);
        if (stub.graphqlErrors) return send(200, { errors: stub.graphqlErrors });
        const variables = (body.variables ?? {}) as { after?: string | null };
        const start = variables.after ? Number(variables.after) : 0;
        const nodes = stub.reviewThreads.slice(start, start + 2);
        const next = start + 2;
        return send(200, {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: {
                    hasNextPage: next < stub.reviewThreads.length,
                    endCursor: next < stub.reviewThreads.length ? String(next) : null,
                  },
                  nodes: nodes.map((thread) => ({
                    isResolved: thread.isResolved,
                    comments: {
                      pageInfo: { hasNextPage: thread.moreComments === true },
                      nodes: thread.commentIds.map((databaseId) => ({ databaseId })),
                    },
                  })),
                },
              },
            },
          },
        });
      }
      // Issue #145: checks of a commit, and a job's log (a redirect to a download, as GitHub does).
      if (/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-runs$/.test(url.pathname)) {
        return send(200, { total_count: stub.checkRuns.length, check_runs: stub.checkRuns });
      }
      if (/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/status$/.test(url.pathname)) {
        return send(200, { state: 'pending', statuses: stub.statuses });
      }
      const jobLog = /^\/repos\/[^/]+\/[^/]+\/actions\/jobs\/(\d+)\/logs$/.exec(url.pathname);
      if (jobLog) {
        const job = stub.jobLogs.get(Number(jobLog[1]));
        if (!job) return send(404, { message: 'Not Found' });
        if ('status' in job) return send(job.status, { message: 'Refused by the stub' });
        response.writeHead(302, { Location: `http://${request.headers.host}/__logs/${jobLog[1]}` });
        return response.end();
      }
      const download = /^\/__logs\/(\d+)$/.exec(url.pathname);
      if (download) {
        const job = stub.jobLogs.get(Number(download[1]));
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        return response.end(job && 'text' in job ? job.text : '');
      }
      // Issue #142: the Agent account itself, and a branch's position against the base.
      if (url.pathname === '/user') return send(200, { login: stub.viewer });
      const branchRoute = /^\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/.exec(url.pathname);
      if (branchRoute) {
        const name = decodeURIComponent(branchRoute[3] as string);
        return stub.missingBranches.includes(name)
          ? send(404, { message: 'Not Found' })
          : send(200, { name });
      }
      const compare = /^\/repos\/([^/]+)\/([^/]+)\/compare\/(.+)\.\.\.(.+)$/.exec(url.pathname);
      if (compare) {
        const head = decodeURIComponent(compare[4] as string);
        if (stub.missingBranches.includes(head)) return send(404, { message: 'Not Found' });
        return send(200, { ahead_by: stub.position.aheadBy, behind_by: stub.position.behindBy });
      }
      // Issue #141: one pull request by number: read it (GET) or change its title and body.
      const single = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(url.pathname);
      if (single) {
        const [, owner, repo, number] = single as unknown as [string, string, string, string];
        const pr = stub.pullRequests.find(
          (candidate) =>
            candidate.owner === owner &&
            candidate.repo === repo &&
            candidate.number === Number(number),
        );
        if (!pr) return send(404, { message: 'Not Found' });
        const full = () => ({
          ...view(pr),
          state: pr.state ?? 'open',
          merged: pr.merged ?? false,
          draft: pr.draft ?? false,
          mergeable: pr.mergeable ?? null,
          head: {
            ref: pr.head,
            repo:
              pr.headRepository === null
                ? null
                : { full_name: pr.headRepository ?? `${pr.owner}/${pr.repo}` },
            sha: pr.headSha ?? 'c'.repeat(40),
          },
          user: { login: pr.author ?? stub.viewer },
          title: pr.title ?? '',
          body: pr.body ?? '',
        });
        if (request.method === 'GET') return send(200, full());
        if (request.method === 'PATCH') {
          const body = await readJson(request);
          if (stub.failUpdate !== undefined) {
            const status = stub.failUpdate;
            stub.failUpdate = undefined;
            return send(status, { message: 'Refused by the stub' });
          }
          stub.updated.push({ owner, repo, number: pr.number, body });
          if (typeof body.title === 'string') pr.title = body.title;
          if (typeof body.body === 'string') pr.body = body.body;
          return send(200, full());
        }
        return send(405, { message: 'Method not allowed' });
      }
      if (!match) return send(404, { message: 'Not Found' });
      const [, owner, repo] = match as unknown as [string, string, string];
      if (request.method === 'GET') {
        const head = url.searchParams.get('head') ?? '';
        return send(
          200,
          stub.pullRequests
            .filter(
              (pr) =>
                pr.owner === owner &&
                pr.repo === repo &&
                `${owner}:${pr.head}` === head &&
                (pr.state ?? 'open') === 'open',
            )
            .map(view),
        );
      }
      if (request.method === 'POST') {
        const body = await readJson(request);
        if (stub.failCreate !== undefined) {
          const status = stub.failCreate;
          stub.failCreate = undefined;
          return send(status, { message: 'Refused by the stub' });
        }
        stub.created.push({ owner, repo, body });
        const pr: StubPullRequest = {
          owner,
          repo,
          head: String(body.head),
          number: stub.pullRequests.length + 1,
          title: String(body.title),
          body: String(body.body),
        };
        stub.pullRequests.push(pr);
        return send(201, view(pr));
      }
      return send(405, { message: 'Method not allowed' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  let closed: Promise<void> | undefined;
  return Object.assign(stub, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      (closed ??= new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })),
  });
}
