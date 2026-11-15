// A local stub of the two GitHub REST routes the agent worker uses for a delivery (#102): the
// open pull requests of a branch, and creating one. `pnpm e2e:smoke` starts it as its own
// process (the smoke runner's event loop is blocked while Playwright runs) on 127.0.0.1 at
// STUB_GITHUB_PORT, and points the worker's STUDIO_AGENT_GITHUB_API_URL at it. Never real
// GitHub. `GET /health` answers 200 once it listens.
import { createServer } from 'node:http';

const port = Number(process.env.STUB_GITHUB_PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error('STUB_GITHUB_PORT must be a port number');
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
    const number = pulls.filter((pr) => pr.repo === `${owner}/${repo}`).length + 1;
    const pr = { repo: `${owner}/${repo}`, head: `${owner}:${body.head}`, number };
    pulls.push(pr);
    console.log(`[stub-github] opened draft pull request #${number} in ${owner}/${repo}`);
    send(201, view(pr));
  });
});

server.listen(port, '127.0.0.1', () => console.log(`[stub-github] listening on ${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
