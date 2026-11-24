// The environment controller phase of the smoke test: a SQL-inserted build, then a stop, on Linux.
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

  const build = await db.previewOperation.create({
    data: {
      projectId,
      kind: 'build',
      status: 'requested',
      commit,
      composeFile: 'compose.yaml',
      service: 'web',
      port: 3000,
      memoryMiB: 1024,
      cpuPercent: 100,
      tasksMax: 512,
      buildMinutes: 20,
    },
  });
  const finished = (id) =>
    until(
      () => db.previewOperation.findUniqueOrThrow({ where: { id } }),
      (row) => row.status === 'succeeded' || row.status === 'failed',
      `operation ${id} to finish`,
    );
  const linesOf = async (id) =>
    (
      await db.previewOperationLine.findMany({
        where: { operationId: id },
        orderBy: { seq: 'asc' },
      })
    ).map((line) => line.text);

  const built = await finished(build.id);
  assert(
    built.status === 'succeeded',
    `the build ${built.status}: ${built.failureCode} ${built.failureDetail}`,
  );
  assert(
    JSON.stringify(built.result) ===
      JSON.stringify({ services: [{ name: 'web', state: 'running' }] }),
    `unexpected result ${JSON.stringify(built.result)}`,
  );
  const buildLines = await linesOf(build.id);
  assert(buildLines.includes('fake build of web'), 'the build log is missing the fake build line');
  assert(
    buildLines.some((line) => line.startsWith('fake build: using DB_PASSWORD=')),
    'the fake build did not echo the Environment value, so redaction is not exercised',
  );
  assert(!buildLines.join('\n').includes(secret), 'the Environment value was stored unredacted');
  assert(
    buildLines.some((line) => line.startsWith('fake bridge created for preview-')),
    'the fake runtime did not start the socket bridge',
  );

  const stop = await db.previewOperation.create({
    data: { projectId, kind: 'stop', status: 'requested' },
  });
  const stopped = await finished(stop.id);
  assert(stopped.status === 'succeeded', `the stop ${stopped.status}`);
  assert(
    (await linesOf(stop.id)).some((line) => line.startsWith('fake bridge removed for preview-')),
    'the stop did not remove the socket bridge',
  );
  console.log(
    '[e2e] controller phase: build succeeded with redacted lines; the bridge was started and removed',
  );
}

export { COMPOSE };
