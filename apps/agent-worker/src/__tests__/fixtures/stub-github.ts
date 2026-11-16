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
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      };
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
