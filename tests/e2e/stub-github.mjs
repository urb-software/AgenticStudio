// A local stub of the GitHub REST routes the agent worker uses for a delivery (#102): the
// open pull requests of a branch, and creating one; Issue #141: one pull request by number,
// read (GET) or updated (PATCH, a repeated delivery after a Follow-up). `pnpm e2e:smoke` starts it as its own
// process (the smoke runner's event loop is blocked while Playwright runs) on 127.0.0.1 at
// STUB_GITHUB_PORT, and points the worker's STUDIO_AGENT_GITHUB_API_URL at it. Never real
// GitHub. `GET /health` answers 200 once it listens.
//
// Issue #142: the reads a pull request lookup makes (the Agent account itself, the pull request
// with its branch, author, draft and merge state, a branch's position against the base), and a
// control endpoint only this smoke uses to change a pull request's state, the way an operator
// does on GitHub (`POST /__control/pulls/<owner>/<repo>/<number>`, no token: the stub listens on
// loopback and holds nothing real).
//
// Like GitHub, it checks what the smoke must prove end to end (Issue #115): every call carries
// the Agent token (`Authorization: Bearer $STUB_GITHUB_TOKEN`, else 401), and a new pull
// request is a draft against the integration branch (`draft: true`, `base` =
// $STUB_GITHUB_BASE, else 422). A refused call fails the delivery, and with it the smoke.
import { createServer } from 'node:http';

const port = Number(process.env.STUB_GITHUB_PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error('STUB_GITHUB_PORT must be a port number');
  process.exit(1);
}
const token = process.env.STUB_GITHUB_TOKEN ?? '';
const base = process.env.STUB_GITHUB_BASE ?? '';
if (!token || !base) {
  console.error('STUB_GITHUB_TOKEN and STUB_GITHUB_BASE must be set');
  process.exit(1);
}

/** The login of the Agent account on this stub (`GET /user`) and the author of every pull request. */
const AGENT_LOGIN = 'studio-agent';

const pulls = [];

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://stub');
  const send = (status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === '/health') return send(200, { status: 'ok' });
  // Issue #142: the smoke changes a pull request's state, as the operator would on GitHub.
  const control = /^\/__control\/pulls\/([^/]+)\/([^/]+)\/(\d+)$/.exec(url.pathname);
  if (control && request.method === 'POST') {
    const [, owner, repo, number] = control;
    const pr = pulls.find(
      (candidate) => candidate.repo === `${owner}/${repo}` && candidate.number === Number(number),
    );
    if (!pr) return send(404, { message: 'Not Found' });
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      const body = JSON.parse(text || '{}');
      if (body.state === 'open' || body.state === 'closed') pr.state = body.state;
      if (typeof body.merged === 'boolean') {
        pr.merged = body.merged;
        if (body.merged) pr.state = 'closed';
      }
      if (typeof body.draft === 'boolean') pr.draft = body.draft;
      if (Number.isInteger(body.behindBy)) pr.behindBy = body.behindBy;
      if (Number.isInteger(body.aheadBy)) pr.aheadBy = body.aheadBy;
      console.log(
        `[stub-github] control: pull request #${pr.number} in ${owner}/${repo} is now ` +
          `${pr.merged ? 'merged' : pr.state}${pr.draft ? ' (draft)' : ''}`,
      );
      send(200, { state: pr.state, merged: pr.merged, draft: pr.draft });
    });
    return;
  }
  const match = /^\/repos\/([^/]+)\/([^/]+)\/pulls(?:\/(\d+))?$/.exec(url.pathname);
  const compare = /^\/repos\/([^/]+)\/([^/]+)\/compare\/(.+)\.\.\.(.+)$/.exec(url.pathname);
  const branches = /^\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/.test(url.pathname);
  if (!match && !compare && !branches && url.pathname !== '/user')
    return send(404, { message: 'Not Found' });
  if (request.headers.authorization !== `Bearer ${token}`) {
    console.log(`[stub-github] refused ${request.method} ${url.pathname}: not the Agent token`);
    return send(401, { message: 'Bad credentials' });
  }
  // Issue #142: the Agent account itself, and a branch's position against the base.
  if (url.pathname === '/user' && request.method === 'GET') {
    return send(200, { login: AGENT_LOGIN });
  }
  const branchRoute = /^\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/.exec(url.pathname);
  if (branchRoute && request.method === 'GET') {
    const name = decodeURIComponent(branchRoute[3]);
    const known = pulls.some(
      (candidate) =>
        candidate.repo === `${branchRoute[1]}/${branchRoute[2]}` && candidate.branch === name,
    );
    return known ? send(200, { name }) : send(404, { message: 'Not Found' });
  }
  if (compare && request.method === 'GET') {
    const head = decodeURIComponent(compare[4]);
    const pr = pulls.find(
      (candidate) => candidate.repo === `${compare[1]}/${compare[2]}` && candidate.branch === head,
    );
    if (!pr) return send(404, { message: 'Not Found' });
    return send(200, { ahead_by: pr.aheadBy, behind_by: pr.behindBy });
  }
  if (!match) return send(405, { message: 'Method not allowed' });
  const [, owner, repo, pullNumber] = match;
  const view = (pr) => ({
    number: pr.number,
    html_url: `https://github.com/${owner}/${repo}/pull/${pr.number}`,
  });
  // Issue #141: one pull request by number: read it (GET) or change its title and body (PATCH).
  if (pullNumber !== undefined) {
    const pr = pulls.find(
      (candidate) =>
        candidate.repo === `${owner}/${repo}` && candidate.number === Number(pullNumber),
    );
    if (!pr) return send(404, { message: 'Not Found' });
    const full = () => ({
      ...view(pr),
      state: pr.state,
      merged: pr.merged,
      draft: pr.draft,
      mergeable: true,
      head: { ref: pr.branch, repo: { full_name: `${owner}/${repo}` } },
      base: { ref: base },
      user: { login: AGENT_LOGIN },
      title: pr.title,
      body: pr.body,
    });
    if (request.method === 'GET') return send(200, full());
    if (request.method !== 'PATCH') return send(405, { message: 'Method not allowed' });
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      const body = JSON.parse(text || '{}');
      if (typeof body.title === 'string') pr.title = body.title;
      if (typeof body.body === 'string') pr.body = body.body;
      console.log(`[stub-github] updated pull request #${pr.number} in ${owner}/${repo}`);
      send(200, full());
    });
    return;
  }
  if (request.method === 'GET') {
    const head = url.searchParams.get('head');
    return send(
      200,
      pulls
        .filter((pr) => pr.repo === `${owner}/${repo}` && pr.head === head && pr.state === 'open')
        .map(view),
    );
  }
  if (request.method !== 'POST') return send(405, { message: 'Method not allowed' });
  let text = '';
  request.on('data', (chunk) => (text += chunk));
  request.on('end', () => {
    const body = JSON.parse(text || '{}');
    if (body.draft !== true || body.base !== base) {
      console.log(
        `[stub-github] refused a pull request: draft ${body.draft}, base ${body.base} ` +
          `(expected a draft against ${base})`,
      );
      return send(422, { message: 'Validation Failed' });
    }
    const number = pulls.filter((pr) => pr.repo === `${owner}/${repo}`).length + 1;
    const pr = {
      repo: `${owner}/${repo}`,
      head: `${owner}:${body.head}`,
      branch: body.head,
      number,
      title: body.title,
      body: body.body,
      // Issue #142: a new pull request is an open draft, one commit ahead of the base.
      state: 'open',
      merged: false,
      draft: true,
      behindBy: 0,
      aheadBy: 1,
    };
    pulls.push(pr);
    console.log(`[stub-github] opened draft pull request #${number} in ${owner}/${repo}`);
    send(201, view(pr));
  });
});

server.listen(port, '127.0.0.1', () => console.log(`[stub-github] listening on ${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
