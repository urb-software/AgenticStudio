// The environment controller phase of the smoke test, on Linux: a build requested through the
// operator route and read back from the Preview and its log, then stop, a second build, reset of
// the data and the disconnect of the Repository, all through the operator routes.
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const COMPOSE = 'services:\n  web:\n    image: nginx:1.27\n    expose:\n      - "3000"\n';

async function until(read, done, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `controller phase: timed out waiting for ${what}; last: ${JSON.stringify(value)}`,
      );
    }
    await delay(250);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`controller phase: ${message}`);
}

/**
 * @param {object} options
 * @param {string} options.apiOrigin API base URL
 * @param {string} options.studioOrigin the Origin header of operator calls
 * @param {string} options.operatorPassword
 * @param {string} options.repositoryUrl file:// URL of a fixture whose `dev` branch holds compose.yaml
 * @param {string} options.commit the commit of that branch
 * @param {import('@agentic-studio/database').DatabaseClient} options.db
 */
export async function runControllerPhase(options) {
  const { apiOrigin, studioOrigin, operatorPassword, repositoryUrl, commit, db } = options;
  // Throwaway value, only to prove redaction: it is never committed or reused.
  const secret = `pw-${randomBytes(9).toString('hex')}`;

  const login = await fetch(`${apiOrigin}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: studioOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: operatorPassword }),
  });
  const session = login.headers.getSetCookie().find((value) => value.startsWith('studio_session='));
  assert(login.status === 200 && session, `login answered ${login.status}`);
  const cookie = session.split(';')[0];
  const call = (path, init = {}) =>
    fetch(`${apiOrigin}${path}`, {
      ...init,
      headers: { Origin: studioOrigin, Cookie: cookie, 'Content-Type': 'application/json' },
    });

  const created = await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `Controller phase ${randomUUID()}` }),
  });
  assert(created.status === 201, `creating the project answered ${created.status}`);
  const { id: projectId } = await created.json();
  const connected = await call(`/api/projects/${projectId}/repository`, {
    method: 'POST',
    body: JSON.stringify({ url: repositoryUrl, integrationBranch: 'dev' }),
  });
  assert(connected.status === 201, `connecting the repository answered ${connected.status}`);
  await until(
    async () => (await (await call(`/api/projects/${projectId}/repository`)).json()).state,
    (state) => state === 'ready' || state === 'failed',
    'the repository to be ready',
  ).then((state) => assert(state === 'ready', `the repository is ${state}`));
  const environmentFile = await call(`/api/projects/${projectId}/environment-file`, {
    method: 'PUT',
    body: JSON.stringify({ path: 'preview.env', content: `DB_PASSWORD=${secret}\n` }),
  });
  assert(environmentFile.status === 200, `the Environment file answered ${environmentFile.status}`);

  const linesOf = async (id) =>
    (
      await db.previewOperationLine.findMany({
        where: { operationId: id },
        orderBy: { seq: 'asc' },
      })
    ).map((line) => line.text);

  // Every answer an operator route gave: none may hold the Environment file's value.
  const answers = [];
  const read = async (path, init) => {
    const response = await call(path, init);
    const text = await response.text();
    answers.push(text);
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  };
  const saved = await read(`/api/projects/${projectId}/preview/settings`, {
    method: 'PUT',
    body: JSON.stringify({ composeFile: 'compose.yaml', service: 'web', port: 3000 }),
  });
  assert(saved.status === 200, `saving the Preview settings answered ${saved.status}`);
  const previewOf = async () => (await read(`/api/projects/${projectId}/preview`)).body;

  await until(
    previewOf,
    (preview) => preview.controller.connected === true,
    'the controller to be connected',
  );
  const queued = await read(`/api/projects/${projectId}/preview/builds`, { method: 'POST' });
  assert(queued.status === 202, `requesting the build answered ${queued.status}`);
  assert(queued.body.status === 'queued', `the new build is ${queued.body.status}`);
  assert(queued.body.commit === commit, 'the build is not of the commit that was validated');
  const buildId = queued.body.id;

  const running = await until(
    previewOf,
    (preview) =>
      preview.state === 'running' ||
      preview.state === 'failed' ||
      preview.latestBuild?.status === 'failed',
    `the Preview to run (build ${buildId})`,
  );
  assert(
    running.state === 'running',
    `the Preview is ${running.state}: ${JSON.stringify(running.latestBuild?.failure)}`,
  );
  assert(running.running.buildId === buildId, 'the running build is not the one requested');
  assert(running.running.commit === commit, `the Preview runs ${running.running.commit}`);
  assert(
    running.running.url === `https://${running.hostname}/` &&
      running.hostname.endsWith('.preview.smoke.test'),
    `unexpected link ${running.running.url}`,
  );
  assert(running.latestBuild.status === 'succeeded', 'the latest build did not succeed');

  const page = await read(`/api/projects/${projectId}/preview/builds/${buildId}/events?limit=1000`);
  assert(page.status === 200, `the events route answered ${page.status}`);
  assert(page.body.final === true && page.body.next === undefined, 'the log is not complete');
  const texts = page.body.events.map((event) => event.text);
  assert(texts.includes('fake build of web'), 'the log is missing the fake build line');
  const echoed = page.body.events.find((event) =>
    event.text.startsWith('fake build: using DB_PASSWORD='),
  );
  assert(
    echoed,
    'the fake build did not echo the Environment value, so redaction is not exercised',
  );
  assert(echoed.redacted === true, 'the redacted line is not marked as redacted');
  for (const answer of answers) {
    assert(!answer.includes(secret), 'an operator answer holds the Environment value');
  }
  const stored = await db.previewOperation.findUniqueOrThrow({ where: { id: buildId } });
  assert(
    JSON.stringify(stored.result) ===
      JSON.stringify({ services: [{ name: 'web', state: 'running' }] }),
    `unexpected result ${JSON.stringify(stored.result)}`,
  );
  const buildLines = await linesOf(buildId);
  assert(!buildLines.join('\n').includes(secret), 'the Environment value was stored unredacted');
  assert(
    buildLines.some((line) => line.startsWith('fake bridge created for preview-')),
    'the fake runtime did not start the socket bridge',
  );

  const post = (path) => read(`/api/projects/${projectId}/preview/${path}`, { method: 'POST' });
  const operationOf = (kind) =>
    db.previewOperation.findFirstOrThrow({
      where: { projectId, kind },
      orderBy: { requestedAt: 'desc' },
    });

  // 1. Stop through the route: stopping, then stopped with the bridge removed.
  const stop = await post('stop');
  assert(stop.status === 202, `stopping answered ${stop.status}`);
  assert(
    stop.body.state === 'stopping',
    `the Preview is ${stop.body.state} after the stop request`,
  );
  const stopped = await until(
    previewOf,
    (preview) => preview.state !== 'stopping' && preview.state !== 'running',
    'the Preview to stop',
  );
  assert(stopped.state === 'stopped', `the Preview is ${stopped.state} after the stop`);
  assert(
    stopped.latestChange.kind === 'stop' && stopped.latestChange.status === 'succeeded',
    'the stop did not succeed',
  );
  const stopOperation = await operationOf('stop');
  assert(
    (await linesOf(stopOperation.id)).some((line) =>
      line.startsWith('fake bridge removed for preview-'),
    ),
    'the stop did not remove the socket bridge',
  );

  // 2. Build again, then reset the data: the volumes go and the same commit runs again.
  const rebuilt = await read(`/api/projects/${projectId}/preview/builds`, { method: 'POST' });
  assert(rebuilt.status === 202, `the second build answered ${rebuilt.status}`);
  const again = await until(
    previewOf,
    (preview) => preview.state === 'running' || preview.state === 'failed',
    'the second build to run',
  );
  assert(again.state === 'running', `the Preview is ${again.state} after the second build`);
  const reset = await post('reset-data');
  assert(reset.status === 202, `resetting answered ${reset.status}`);
  assert(
    reset.body.state === 'resetting_data',
    `the Preview is ${reset.body.state} after the reset request`,
  );
  const afterReset = await until(
    previewOf,
    (preview) => preview.state === 'running' && preview.running.buildId !== again.running.buildId,
    'the Preview to run again after the reset',
  );
  assert(afterReset.running.commit === again.running.commit, 'the reset rebuilt another commit');
  assert(
    afterReset.latestChange.kind === 'reset_data' && afterReset.latestChange.status === 'succeeded',
    'the reset did not succeed',
  );
  assert(
    (await linesOf((await operationOf('remove_data')).id)).some((line) =>
      line.startsWith('fake volumes removed for preview-'),
    ),
    'the reset did not remove the volumes',
  );
  const previews = async () => (await read('/api/previews')).body;
  assert(
    (await previews()).previews.some((entry) => entry.projectId === projectId),
    'GET /api/previews does not list the running Preview',
  );

  // 3. Disconnect: the Preview is stopped and its data removed, then the disconnect finishes.
  const disconnect = await read(`/api/projects/${projectId}/repository`, { method: 'DELETE' });
  assert(
    disconnect.status === 202 || disconnect.status === 204,
    `disconnecting answered ${disconnect.status}`,
  );
  await until(
    async () => (await call(`/api/projects/${projectId}/repository`)).status,
    (status) => status === 404,
    'the disconnect to finish',
    150_000,
  );
  assert(
    !(await previews()).previews.some((entry) => entry.projectId === projectId),
    'GET /api/previews still lists the disconnected Project',
  );
  assert(
    (await db.previewOperation.count({ where: { projectId } })) === 0,
    'the disconnect left Preview operations behind',
  );
  console.log(
    '[e2e] controller phase: the Preview was built, stopped, rebuilt, reset and removed on disconnect through the operator routes; no answer held the secret',
  );
}

export { COMPOSE };
