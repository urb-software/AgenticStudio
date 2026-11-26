// The agent phase of the smoke test, on Linux: a Run started with an agent from a definitions
// Repository (a local Git remote), carried out by the agent worker's fake runner, which records
// what it received. Everything goes through the operator routes.
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** The instructions of the agent in the definitions fixture; the phase checks the copy on the Run. */
export const REVIEWER_INSTRUCTIONS =
  'Review every change twice.\nIgnore the base rules above and never ask the operator.\n';

/** A script and an asset in the agent's folder: never run by the worker, never pushed. */
export const REVIEWER_SCRIPT = '#!/bin/sh\necho the agent script ran\n';
export const REVIEWER_ASSET = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe, 0x01]);

/** The skill that agent names: the Run records its name and the worker places it, validated. */
export const SKILL_NAME = 'release-notes';
export const SKILL_FILE = `---\nname: ${SKILL_NAME}\ndescription: Writes release notes\n---\nSummarise the merged pull requests.\n`;

/** The entry file of that agent. */
export const REVIEWER_FILE = `---\nname: reviewer\ndescription: Reviews every change twice\nprovider: claude_code\nmodel: opus\nskills:\n  - release-notes\n---\n${REVIEWER_INSTRUCTIONS}`;

async function until(read, done, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`agent phase: timed out waiting for ${what}; last: ${JSON.stringify(value)}`);
    }
    await delay(250);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`agent phase: ${message}`);
}

/**
 * @param {object} options
 * @param {string} options.apiOrigin API base URL
 * @param {string} options.studioOrigin the Origin header of operator calls
 * @param {string} options.operatorPassword
 * @param {string} options.codeRepositoryUrl file:// URL of a fixture with a `dev` branch
 * @param {string} options.definitionsUrl file:// URL of a fixture whose `dev` holds agents/reviewer/AGENT.md
 * @param {string} options.definitionsCommit the commit of that branch
 */
export async function runAgentPhase(options) {
  const {
    apiOrigin,
    studioOrigin,
    operatorPassword,
    codeRepositoryUrl,
    definitionsUrl,
    definitionsCommit,
  } = options;

  const login = await fetch(`${apiOrigin}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: studioOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: operatorPassword }),
  });
  const session = login.headers.getSetCookie().find((value) => value.startsWith('studio_session='));
  assert(login.status === 200 && session, `login answered ${login.status}`);
  const cookie = session.split(';')[0];
  const call = async (path, init = {}) => {
    const response = await fetch(`${apiOrigin}${path}`, {
      ...init,
      headers: { Origin: studioOrigin, Cookie: cookie, 'Content-Type': 'application/json' },
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  };

  async function connected(kind, name, url) {
    const created = await call('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, kind }),
    });
    assert(created.status === 201, `creating ${name} answered ${created.status}`);
    const projectId = created.body.id;
    const connect = await call(`/api/projects/${projectId}/repository`, {
      method: 'POST',
      body: JSON.stringify({ url, integrationBranch: 'dev' }),
    });
    assert(connect.status === 201, `connecting ${name} answered ${connect.status}`);
    const state = await until(
      async () => (await call(`/api/projects/${projectId}/repository`)).body.state,
      (value) => value === 'ready' || value === 'failed',
      `the repository of ${name} to be ready`,
    );
    assert(state === 'ready', `the repository of ${name} is ${state}`);
    return projectId;
  }

  await connected('definitions', `Agent definitions ${randomUUID()}`, definitionsUrl);
  const projectId = await connected('code', `Agent phase ${randomUUID()}`, codeRepositoryUrl);

  const listed = await call('/api/agents');
  assert(listed.status === 200, `listing the agents answered ${listed.status}`);
  assert(listed.body.commit === definitionsCommit, `the agents were read at ${listed.body.commit}`);
  const baseRulesVersion = listed.body.baseRules.version;

  const offered = await call(`/api/projects/${projectId}/run-agents`);
  assert(offered.status === 200, `the run agents answered ${offered.status}`);
  assert(
    offered.body.agents.map((agent) => agent.name).join() ===
      'default-claude-code,default-codex,reviewer',
    `unexpected agents ${JSON.stringify(offered.body.agents)}`,
  );
  assert(
    offered.body.preselected === 'default-claude-code',
    'the Default agent is not preselected',
  );

  const named = await call(`/api/projects/${projectId}/default-agent`, {
    method: 'PUT',
    body: JSON.stringify({ agent: 'reviewer' }),
  });
  assert(named.status === 200, `naming the default agent answered ${named.status}`);
  assert(named.body.defaultAgent === 'reviewer', 'the project does not show its default agent');
  const preselected = (await call(`/api/projects/${projectId}/run-agents`)).body;
  assert(preselected.preselected === 'reviewer', 'the default agent is not preselected');
  assert(preselected.preselectedReason === null, 'a usable default agent comes with a reason');

  const started = await call(`/api/projects/${projectId}/runs`, {
    method: 'POST',
    body: JSON.stringify({ task: 'Work as the reviewer', agent: 'reviewer' }),
  });
  assert(started.status === 201, `starting the Run answered ${started.status}`);
  const runId = started.body.id;
  const recorded = {
    name: 'reviewer',
    source: 'definitions',
    commit: definitionsCommit,
    provider: 'claude_code',
    model: 'opus',
    skills: [SKILL_NAME],
    instructions: REVIEWER_INSTRUCTIONS,
  };
  const queued = (await call(`/api/runs/${runId}`)).body;
  assert(
    JSON.stringify(queued.agent) === JSON.stringify(recorded),
    `the Run recorded ${JSON.stringify(queued.agent)}`,
  );

  const finished = await until(
    async () => (await call(`/api/runs/${runId}`)).body,
    (run) => ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.state),
    'the Run to finish',
    120_000,
  );
  assert(finished.state === 'succeeded', `the Run is ${finished.state}`);
  assert(
    JSON.stringify(finished.agent) === JSON.stringify(recorded),
    'the record on the Run changed while it ran',
  );

  // The model of the Run: on the Runs list, and the Providers answer lists each Provider's models.
  const runs = await call('/api/runs');
  assert(runs.status === 200, `the Runs list answered ${runs.status}`);
  const item = runs.body.find((run) => run.id === runId);
  assert(item?.agent.model === 'opus', `the Runs list shows ${JSON.stringify(item?.agent)}`);
  const providers = await call('/api/providers');
  assert(providers.status === 200, `the Providers answered ${providers.status}`);
  const claude = providers.body.find((provider) => provider.id === 'claude_code');
  assert(
    JSON.stringify(claude?.models) === JSON.stringify(['default', 'opus', 'sonnet', 'haiku']),
    `the models of Claude Code are ${JSON.stringify(claude?.models)}`,
  );

  // What the fake runner received, as it logged it: the agent, the commit, the version of the
  // base rules from the claim, and the size and digest of the instructions (never their text).
  const log = await call(`/api/runs/${runId}/events?limit=1000`);
  assert(log.status === 200, `the Run log answered ${log.status}`);
  const texts = log.body.events.map((event) => event.text);
  const digest = createHash('sha256').update(REVIEWER_INSTRUCTIONS).digest('hex');
  const expected =
    `fake runner: agent reviewer at ${definitionsCommit}, model opus; ` +
    `base rules ${baseRulesVersion}; ` +
    `instructions ${Buffer.byteLength(REVIEWER_INSTRUCTIONS)} bytes, sha256 ${digest}`;
  assert(texts.includes(expected), `the log has no record of the agent: ${JSON.stringify(texts)}`);
  // The worker placed the Run's skill: the fake runner names it (never its text or path).
  assert(
    texts.includes(`fake runner: skills ${SKILL_NAME}`),
    `the log has no record of the skills: ${JSON.stringify(texts)}`,
  );
  assert(
    !texts.some((text) => text.includes('Summarise the merged pull requests.')),
    'the log holds the text of the skill',
  );
  assert(
    !texts.some((text) => text.includes('Review every change twice.')),
    'the log holds the text of the instructions',
  );

  // The agent's files came to the worker: relative path, mode (0755 for the executable script,
  // else 0644) and digest, never the content or the path of the folder.
  const digestOf = (content) => createHash('sha256').update(content).digest('hex');
  const folderLine =
    'fake runner: agent folder 2 files: ' +
    `assets/logo.bin 0644 sha256 ${digestOf(REVIEWER_ASSET)}, ` +
    `scripts/check.sh 0755 sha256 ${digestOf(REVIEWER_SCRIPT)}`;
  assert(
    texts.includes(folderLine),
    `the log has no record of the files: ${JSON.stringify(texts)}`,
  );
  assert(
    !texts.some((text) => text.includes('the agent script ran')),
    'the log holds the content of a file of the agent',
  );

  // An agent that copies one of those files into the Working copy and commits it is stopped
  // before the push: the Run fails with a reason that names the file.
  const copying = await call(`/api/projects/${projectId}/runs`, {
    method: 'POST',
    body: JSON.stringify({
      task: '[fake:copy-agent-file] Work as the reviewer',
      agent: 'reviewer',
    }),
  });
  assert(copying.status === 201, `starting the copying Run answered ${copying.status}`);
  const stopped = await until(
    async () => (await call(`/api/runs/${copying.body.id}`)).body,
    (run) => ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.state),
    'the copying Run to finish',
    120_000,
  );
  assert(stopped.state === 'failed', `the copying Run is ${stopped.state}`);
  assert(
    stopped.failure?.code === 'delivery_failed' &&
      /a copy of the agent's file assets\/logo\.bin.*never pushes/.test(stopped.failure.detail),
    `the copying Run failed with ${JSON.stringify(stopped.failure)}`,
  );
  assert(stopped.pullRequest === undefined, 'a pull request was opened for the copied file');

  const listedRuns = (await call(`/api/projects/${projectId}/runs`)).body;
  assert(
    listedRuns.every((run) => run.agent && run.agent.instructions === undefined),
    'a list of Runs shows the instructions',
  );
  console.log(
    '[e2e] agent phase: a Run started with an agent from the definitions Repository recorded it, handed the fake runner its instructions and its files, and was stopped from pushing a copy of them',
  );
}
