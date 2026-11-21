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
// Issue #145: the reads for a pull request's checks (`GET /commits/<sha>/check-runs` and `/status`)
// and the log of an Actions job (`GET /actions/jobs/<id>/logs`, a 302 to a download that takes no
// token, as GitHub does), and the same control endpoint sets what they answer (`checkRuns`,
// `statuses`, `jobLogs`, `headSha`).
//
// Issue #146: the reads for a pull request's Review comments (its reviews, inline comments and
// conversation comments, a hundred to a page, and the review threads through a read-only GraphQL
// query), set through the same control endpoint (`reviews`, `inlineComments`, `issueComments`,
// `reviewThreads`).
//
// Story #263: the writes Studio's Merge adapter makes to close a pull request (`PATCH .../pulls/<n>`
// with `state: closed`) and to delete a Run branch (`DELETE .../git/refs/heads/<branch>`). They
// accept only the Merge credential (`STUB_GITHUB_MERGE_TOKEN`), never the Agent token (403), and
// the Merge credential reads pull requests too. `GET /__control/audit` lists the writes it
// accepted and refused, by who made them, for the smoke to check.
//
// The writes Studio's Merge adapter makes to merge a pull request: the GraphQL mutation
// that marks it ready, an approving review (`POST .../pulls/<n>/reviews`) and the merge
// (`PUT .../pulls/<n>/merge`, which honours `sha` and answers 409 when the head moved). Like the
// two writes above, they accept only the Merge credential.
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
const mergeToken = process.env.STUB_GITHUB_MERGE_TOKEN ?? '';
if (!token || !base) {
  console.error('STUB_GITHUB_TOKEN and STUB_GITHUB_BASE must be set');
  process.exit(1);
}
if (!mergeToken || mergeToken === token) {
  console.error('STUB_GITHUB_MERGE_TOKEN must be set, and differ from STUB_GITHUB_TOKEN');
  process.exit(1);
}

/** The login of the Agent account on this stub (`GET /user`) and the author of every pull request. */
const AGENT_LOGIN = 'studio-agent';

const pulls = [];

/** Story #263: the writes it accepted and refused, as `{ method, path, role }`. */
const audit = {
  accepted: [],
  refused: [],
  deletedBranches: [],
  markedReady: [],
  approvals: [],
  merges: [],
};

/** The commit a merge creates on the base branch. */
const MERGE_COMMIT = 'e'.repeat(40);

/** Issue #145: what the checks routes answer, as GitHub words them; set through the control endpoint. */
let checkRuns = [];
let statuses = [];
/** Job id (string) to the text of its log. */
let jobLogs = {};

/** Issue #146: what the comment routes answer, as GitHub words them; set through the control endpoint. */
let reviews = [];
let inlineComments = [];
let issueComments = [];
/** The review threads the GraphQL query answers: `{ isResolved, commentIds }`. */
let reviewThreads = [];

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://stub');
  const send = (status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === '/health') return send(200, { status: 'ok' });
  if (url.pathname === '/__control/audit' && request.method === 'GET') return send(200, audit);
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
      if (typeof body.headSha === 'string') pr.headSha = body.headSha;
      if (Array.isArray(body.checkRuns)) checkRuns = body.checkRuns;
      if (Array.isArray(body.statuses)) statuses = body.statuses;
      if (body.jobLogs && typeof body.jobLogs === 'object') jobLogs = body.jobLogs;
      if (Array.isArray(body.reviews)) reviews = body.reviews;
      if (Array.isArray(body.inlineComments)) inlineComments = body.inlineComments;
      if (Array.isArray(body.issueComments)) issueComments = body.issueComments;
      if (Array.isArray(body.reviewThreads)) reviewThreads = body.reviewThreads;
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
  const checksRoute = /^\/repos\/([^/]+)\/([^/]+)\/commits\/[^/]+\/(check-runs|status)$/.exec(
    url.pathname,
  );
  const logRoute = /^\/repos\/([^/]+)\/([^/]+)\/actions\/jobs\/(\d+)\/logs$/.exec(url.pathname);
  // The download a log redirects to takes no token (it is a signed address on GitHub).
  const download = /^\/__logs\/(\d+)$/.exec(url.pathname);
  if (download && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    return response.end(jobLogs[download[1]] ?? '');
  }
  const commentsRoute =
    /^\/repos\/([^/]+)\/([^/]+)\/pulls\/\d+\/(reviews|comments)$/.exec(url.pathname) ??
    /^\/repos\/([^/]+)\/([^/]+)\/(issues)\/\d+\/comments$/.exec(url.pathname);
  const graphql = url.pathname === '/graphql';
  const mergeRoute = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/.exec(url.pathname);
  const reviewsRoute = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/.exec(url.pathname);
  const refsRoute = /^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/.exec(url.pathname);
  if (
    !match &&
    !compare &&
    !branches &&
    !checksRoute &&
    !logRoute &&
    !commentsRoute &&
    !graphql &&
    !mergeRoute &&
    !refsRoute &&
    url.pathname !== '/user'
  )
    return send(404, { message: 'Not Found' });
  const role =
    request.headers.authorization === `Bearer ${token}`
      ? 'agent'
      : request.headers.authorization === `Bearer ${mergeToken}`
        ? 'merge'
        : null;
  if (role === null) {
    console.log(`[stub-github] refused ${request.method} ${url.pathname}: unknown token`);
    return send(401, { message: 'Bad credentials' });
  }
  /** A write only the Merge credential may make. */
  const mergeWrite = (method, path) => {
    if (role === 'merge') {
      audit.accepted.push({ method, path, role });
      return true;
    }
    audit.refused.push({ method, path, role });
    console.log(
      `[stub-github] refused ${method} ${path}: the ${role} credential cannot write this`,
    );
    send(403, { message: 'Resource not accessible by this token' });
    return false;
  };
  if (refsRoute && request.method === 'DELETE') {
    if (!mergeWrite('DELETE', url.pathname)) return;
    const name = decodeURIComponent(refsRoute[3]);
    const pr = pulls.find(
      (candidate) =>
        candidate.repo === `${refsRoute[1]}/${refsRoute[2]}` &&
        candidate.branch === name &&
        !candidate.branchDeleted,
    );
    if (!pr) return send(422, { message: 'Reference does not exist' });
    pr.branchDeleted = true;
    audit.deletedBranches.push(name);
    console.log(`[stub-github] deleted branch ${name} in ${pr.repo}`);
    return response.writeHead(204).end();
  }
  if (refsRoute) return send(405, { message: 'Method not allowed' });
  const readJson = (done) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => done(JSON.parse(text || '{}')));
  };
  const pullOf = (owner, repo, number) =>
    pulls.find(
      (candidate) => candidate.repo === `${owner}/${repo}` && candidate.number === Number(number),
    );
  if (mergeRoute && request.method === 'PUT') {
    if (!mergeWrite('PUT', url.pathname)) return;
    return readJson((body) => {
      const pr = pullOf(mergeRoute[1], mergeRoute[2], mergeRoute[3]);
      if (!pr) return send(404, { message: 'Not Found' });
      if (pr.merged || pr.state !== 'open') {
        console.log(`[stub-github] refused merge of #${pr.number}: ${pr.state}`);
        return send(405, { message: 'Pull Request is not mergeable' });
      }
      if (pr.draft) return send(405, { message: 'Draft pull requests cannot be merged' });
      if (body.sha !== (pr.headSha ?? 'c'.repeat(40))) {
        console.log(
          `[stub-github] refused merge of #${pr.number}: head is ${pr.headSha}, got ${body.sha}`,
        );
        return send(409, { message: 'Head branch was modified. Review and try the merge again.' });
      }
      pr.merged = true;
      pr.state = 'closed';
      audit.merges.push({
        repo: pr.repo,
        number: pr.number,
        sha: body.sha,
        method: body.merge_method,
        title: body.commit_title,
      });
      console.log(`[stub-github] merged pull request #${pr.number} in ${pr.repo}`);
      send(200, { sha: MERGE_COMMIT, merged: true, message: 'Pull Request successfully merged' });
    });
  }
  if (reviewsRoute && request.method === 'POST') {
    if (!mergeWrite('POST', url.pathname)) return;
    return readJson((body) => {
      const pr = pullOf(reviewsRoute[1], reviewsRoute[2], reviewsRoute[3]);
      if (!pr) return send(404, { message: 'Not Found' });
      audit.approvals.push({
        repo: pr.repo,
        number: pr.number,
        event: body.event,
        commit: body.commit_id,
      });
      send(200, { id: audit.approvals.length, state: 'APPROVED' });
    });
  }
  if (
    role === 'merge' &&
    request.method !== 'GET' &&
    !(match && request.method === 'PATCH') &&
    !graphql
  ) {
    audit.refused.push({ method: request.method, path: url.pathname, role });
    return send(403, { message: 'The Merge credential cannot write this' });
  }
  if (checksRoute && request.method === 'GET') {
    return checksRoute[3] === 'check-runs'
      ? send(200, { total_count: checkRuns.length, check_runs: checkRuns })
      : send(200, { state: 'pending', statuses });
  }
  if (commentsRoute && request.method === 'GET') {
    const list =
      commentsRoute[3] === 'reviews'
        ? reviews
        : commentsRoute[3] === 'comments'
          ? inlineComments
          : issueComments;
    const size = Number(url.searchParams.get('per_page') ?? 30);
    const page = Number(url.searchParams.get('page') ?? 1);
    return send(200, list.slice((page - 1) * size, page * size));
  }
  if (graphql && request.method === 'POST') {
    return readJson((body) => {
      if (String(body.query).includes('markPullRequestReadyForReview')) {
        if (!mergeWrite('POST', url.pathname)) return;
        const pr = pulls.find(
          (candidate) => `PR_stub_${candidate.repo}_${candidate.number}` === body.variables?.id,
        );
        if (!pr) return send(200, { errors: [{ message: 'Could not resolve to a node.' }] });
        pr.draft = false;
        audit.markedReady.push({ repo: pr.repo, number: pr.number });
        console.log(`[stub-github] marked pull request #${pr.number} ready for review`);
        return send(200, {
          data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
        });
      }
      send(200, {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: reviewThreads.map((thread) => ({
                  isResolved: thread.isResolved,
                  comments: {
                    pageInfo: { hasNextPage: false },
                    nodes: thread.commentIds.map((databaseId) => ({ databaseId })),
                  },
                })),
              },
            },
          },
        },
      });
    });
  }
  if (logRoute && request.method === 'GET') {
    if (!(logRoute[3] in jobLogs)) return send(404, { message: 'Not Found' });
    response.writeHead(302, { Location: `http://${request.headers.host}/__logs/${logRoute[3]}` });
    return response.end();
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
        candidate.repo === `${branchRoute[1]}/${branchRoute[2]}` &&
        candidate.branch === name &&
        !candidate.branchDeleted,
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
      node_id: `PR_stub_${pr.repo}_${pr.number}`,
      state: pr.state,
      merged: pr.merged,
      draft: pr.draft,
      mergeable: true,
      head: {
        ref: pr.branch,
        sha: pr.headSha ?? 'c'.repeat(40),
        repo: { full_name: `${owner}/${repo}` },
      },
      base: { ref: base, repo: { full_name: `${owner}/${repo}` } },
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
      if (body.state !== undefined) {
        if (!mergeWrite('PATCH', url.pathname)) return;
        if (body.state === 'closed') pr.state = 'closed';
        console.log(`[stub-github] closed pull request #${pr.number} in ${owner}/${repo}`);
        return send(200, full());
      }
      if (role !== 'agent') {
        audit.refused.push({ method: 'PATCH', path: url.pathname, role });
        return send(403, { message: 'Resource not accessible by this token' });
      }
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
