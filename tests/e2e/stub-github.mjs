// A local stub of the two GitHub REST routes the agent worker uses for a delivery (#102): the
// open pull requests of a branch, and creating one. `pnpm e2e:smoke` starts it as its own
// process (the smoke runner's event loop is blocked while Playwright runs) on 127.0.0.1 at
// STUB_GITHUB_PORT, and points the worker's STUDIO_AGENT_GITHUB_API_URL at it. Never real
// GitHub. `GET /health` answers 200 once it listens.
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

const pulls = [];

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://stub');
  const send = (status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === '/health') return send(200, { status: 'ok' });
  const match = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname);
  if (!match) return send(404, { message: 'Not Found' });
  const [, owner, repo] = match;
  if (request.headers.authorization !== `Bearer ${token}`) {
    console.log(`[stub-github] refused ${request.method} ${url.pathname}: not the Agent token`);
    return send(401, { message: 'Bad credentials' });
  }
  const view = (pr) => ({
    number: pr.number,
    html_url: `https://github.com/${owner}/${repo}/pull/${pr.number}`,
  });
  if (request.method === 'GET') {
    const head = url.searchParams.get('head');
    return send(
      200,
      pulls.filter((pr) => pr.repo === `${owner}/${repo}` && pr.head === head).map(view),
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
    const pr = { repo: `${owner}/${repo}`, head: `${owner}:${body.head}`, number };
    pulls.push(pr);
    console.log(`[stub-github] opened draft pull request #${number} in ${owner}/${repo}`);
    send(201, view(pr));
  });
});

server.listen(port, '127.0.0.1', () => console.log(`[stub-github] listening on ${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
