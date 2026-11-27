// The agent phase of the smoke test, on Linux: a Run started with an agent from a definitions
// Repository (a local Git remote), carried out by the agent worker's fake runner, which records
// what it received. Everything goes through the operator routes.
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { runCheckpointPhase } from './checkpoint-phase.mjs';

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

/** A second agent and a Workflow of two work Phases that name one agent each. */
export const HELPER_FILE =
  '---\nname: helper\ndescription: Polishes what the first Phase did\nprovider: claude_code\nmodel: sonnet\n---\nPolish the work.\n';
export const TWO_PHASES_FILE =
  '---\nname: two-phases\ndescription: Two work Phases, one agent each\nsequence:\n' +
  '  - id: first\n    kind: work\n    agent: reviewer\n' +
  '  - id: second\n    kind: work\n    agent: helper\n---\nNotes for the operator.\n';

/** A Workflow of "implement, then review": a work Phase and a review Phase. */
export const IMPLEMENT_REVIEW_FILE =
  '---\nname: implement-review\ndescription: Implement, then review\nsequence:\n' +
  '  - id: implement\n    kind: work\n    agent: helper\n' +
  '  - id: review\n    kind: review\n    agent: reviewer\n---\nNotes for the operator.\n';

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
      'default-claude-code,default-codex,helper,reviewer',
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

  await runWorkflowPhase({ call, projectId, definitionsCommit });
  await runReviewPhase({ call, projectId });
  await runCheckpointPhase({ call, projectId });

  const listedRuns = (await call(`/api/projects/${projectId}/runs`)).body;
  assert(
    listedRuns.every((run) => run.agent && run.agent.instructions === undefined),
    'a list of Runs shows the instructions',
  );
  console.log(
    '[e2e] agent phase: a Run started with an agent from the definitions Repository recorded it, handed the fake runner its instructions and its files, and was stopped from pushing a copy of them',
  );
}

/** A Run started with a Workflow of two work Phases: the record, the order and the hand-over. */
async function runWorkflowPhase({ call, projectId, definitionsCommit }) {
  const listed = await call('/api/workflows');
  assert(listed.status === 200, `listing the Workflows answered ${listed.status}`);
  const flow = listed.body.workflows.find((workflow) => workflow.name === 'two-phases');
  assert(flow?.valid && flow.usable, `the Workflow is ${JSON.stringify(flow)}`);

  // Refusals of the start, over HTTP.
  const unknown = await call(`/api/projects/${projectId}/runs`, {
    method: 'POST',
    body: JSON.stringify({ task: 'x', workflow: 'no-such-workflow' }),
  });
  assert(
    unknown.status === 409 && unknown.body.type === 'urn:agentic-studio:problem:workflow-unknown',
    `an unknown Workflow answered ${unknown.status} ${JSON.stringify(unknown.body)}`,
  );
  const both = await call(`/api/projects/${projectId}/runs`, {
    method: 'POST',
    body: JSON.stringify({ task: 'x', workflow: 'two-phases', agent: 'reviewer' }),
  });
  assert(both.status === 422, `an agent with a Workflow answered ${both.status}`);

  const started = await call(`/api/projects/${projectId}/runs`, {
    method: 'POST',
    body: JSON.stringify({
      task: 'Work through the Workflow [fake:dirty]',
      workflow: 'two-phases',
    }),
  });
  assert(started.status === 201, `starting the Workflow Run answered ${started.status}`);
  const runId = started.body.id;
  const queued = (await call(`/api/runs/${runId}`)).body;
  assert(queued.workflowName === 'two-phases', 'the Run does not name its Workflow');
  assert(
    queued.workflow.commit === definitionsCommit &&
      queued.workflow.items.map((item) => `${item.id}:${item.agent}`).join() ===
        'first:reviewer,second:helper',
    `the Run recorded ${JSON.stringify(queued.workflow)}`,
  );
  assert(
    queued.phases
      .map((phase) => `${phase.itemId}:${phase.agent.name}:${phase.agent.commit}`)
      .join() === `first:reviewer:${definitionsCommit},second:helper:${definitionsCommit}`,
    `the Phases recorded ${JSON.stringify(queued.phases)}`,
  );

  const finished = await until(
    async () => (await call(`/api/runs/${runId}`)).body,
    (run) => ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.state),
    'the Workflow Run to finish',
    180_000,
  );
  assert(finished.state === 'succeeded', `the Workflow Run is ${finished.state}`);
  assert(
    finished.phases.every((phase) => phase.state === 'done' && phase.stepsUsed === 1),
    `the Phases ended as ${JSON.stringify(finished.phases)}`,
  );
  assert(
    finished.phases[0].summary === 'The fake agent finished the task. (Phase first)' &&
      finished.phases[1].summary === 'The fake agent finished the task. (Phase second)',
    `the Phases reported ${JSON.stringify(finished.phases.map((phase) => phase.summary))}`,
  );
  // Delivery happened once, after the last Phase: one pull request, and the one commit holds the
  // change both Phases left in the Working copy (nothing was committed or pushed between them).
  assert(
    finished.delivery === 'delivered' && finished.pullRequest?.number >= 1,
    `the Workflow Run delivered ${finished.delivery} with ${JSON.stringify(finished.pullRequest)}`,
  );
  assert(
    finished.commits?.length === 1 && finished.commits[0].pushed === true,
    `the Workflow Run has the commits ${JSON.stringify(finished.commits)}`,
  );
  assert(finished.agent.name === 'helper', 'the Run does not show the agent of its last Phase');

  const listedRuns = await call('/api/runs');
  assert(
    listedRuns.body.find((run) => run.id === runId)?.workflowName === 'two-phases',
    'the Runs list does not name the Workflow',
  );

  // The log marks where each Phase starts and ends; the second Phase was told what the first
  // one reported and ran in a session of its own.
  const log = await call(`/api/runs/${runId}/events?limit=1000`);
  const texts = log.body.events.map((event) => event.text);
  for (const expected of [
    'Phase first (1/2): agent reviewer, Claude Code',
    'Phase first (1/2) ended: done',
    'Phase second (2/2): agent helper, Claude Code',
    'Phase second (2/2) ended: done',
    'fake runner: phase second (2/2)',
    'fake runner: told by phase first: The fake agent finished the task. (Phase first)',
  ]) {
    assert(texts.includes(expected), `the log lacks "${expected}": ${JSON.stringify(texts)}`);
  }
  const order = (text) => texts.indexOf(text);
  assert(
    order('Phase first (1/2) ended: done') < order('Phase second (2/2): agent helper, Claude Code'),
    'the Phases did not run in order',
  );

  // The Project's default may be a Workflow: a start that names nothing starts it.
  const named = await call(`/api/projects/${projectId}/default-agent`, {
    method: 'PUT',
    body: JSON.stringify({ workflow: 'two-phases' }),
  });
  assert(
    named.status === 200 &&
      named.body.defaultWorkflow === 'two-phases' &&
      named.body.defaultAgent === null,
    `naming the default Workflow answered ${named.status} ${JSON.stringify(named.body)}`,
  );
  const byDefault = await call(`/api/projects/${projectId}/runs`, {
    method: 'POST',
    body: JSON.stringify({ task: 'Start the default' }),
  });
  assert(byDefault.status === 201, `the default start answered ${byDefault.status}`);
  const defaulted = await until(
    async () => (await call(`/api/runs/${byDefault.body.id}`)).body,
    (run) => ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.state),
    'the default Workflow Run to finish',
    180_000,
  );
  assert(
    defaulted.state === 'succeeded' && defaulted.workflowName === 'two-phases',
    `the default Run is ${defaulted.state} of ${defaulted.workflowName}`,
  );
  await call(`/api/projects/${projectId}/default-agent`, {
    method: 'PUT',
    body: JSON.stringify({ agent: null, workflow: null }),
  });
  console.log(
    '[e2e] workflow phase: a Run started with a Workflow of two work Phases recorded it, ran the Phases in order in sessions of their own, handed the second what the first reported and delivered once',
  );
}

/**
 * "Implement, then review" with the fake runner: an approval, changes requested (the pull request
 * is delivered all the same, with the findings), a review that changes the Working copy (the
 * change never reaches the pull request) and a review that ends without a Verdict.
 */
async function runReviewPhase({ call, projectId }) {
  const listed = await call('/api/workflows');
  const flow = listed.body.workflows.find((workflow) => workflow.name === 'implement-review');
  assert(flow?.valid && flow.usable, `the Workflow is ${JSON.stringify(flow)}`);

  const finish = async (task, what) => {
    const started = await call(`/api/projects/${projectId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ task, workflow: 'implement-review' }),
    });
    assert(started.status === 201, `starting the ${what} Run answered ${started.status}`);
    return until(
      async () => (await call(`/api/runs/${started.body.id}`)).body,
      (run) => ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.state),
      `the ${what} Run to finish`,
      180_000,
    );
  };

  const approved = await finish('Add a file [fake:commit] [fake-review:approved]', 'approved');
  assert(approved.state === 'succeeded', `the approved Run is ${approved.state}`);
  assert(
    approved.phases.map((phase) => `${phase.kind}:${phase.verdict}`).join() ===
      'work:null,review:approved' && approved.reviewNotPassed === false,
    `the approved Run's Phases are ${JSON.stringify(approved.phases)}`,
  );
  assert(
    approved.delivery === 'delivered' &&
      approved.pullRequest?.number >= 1 &&
      approved.commits?.length === 1,
    `the approved Run delivered ${approved.delivery} with ${JSON.stringify(approved.commits)}`,
  );

  const changes = await finish(
    'Add a file [fake:commit] [fake-review:changes]',
    'changes requested',
  );
  assert(changes.state === 'succeeded', `the changes-requested Run is ${changes.state}`);
  const review = changes.phases[1];
  assert(
    review.kind === 'review' &&
      review.state === 'done' &&
      review.verdict === 'changes_requested' &&
      review.findings.length === 2 &&
      review.findings[0].file === 'FAKE_CHANGE.md' &&
      review.findings[0].line === 1 &&
      review.findings[1].text.startsWith('<b>Not bold</b>'),
    `the review is ${JSON.stringify(review)}`,
  );
  assert(changes.reviewNotPassed === true, 'the Run does not say its review did not pass');
  assert(
    changes.delivery === 'delivered' && changes.pullRequest?.number >= 1,
    `the changes-requested Run delivered ${changes.delivery} with ${JSON.stringify(changes.pullRequest)}`,
  );
  const listedRuns = await call('/api/runs');
  assert(
    listedRuns.body.find((run) => run.id === changes.id)?.reviewNotPassed === true &&
      listedRuns.body.find((run) => run.id === approved.id)?.reviewNotPassed === false,
    'the Runs list does not mark the Run whose review did not pass',
  );
  assert(
    listedRuns.body.every((run) => run.phases === undefined),
    'a list of Runs shows the Phases and so the findings',
  );

  const careless = await finish('Add a file [fake:commit] [fake-review:edits]', 'careless review');
  assert(careless.state === 'succeeded', `the careless-review Run is ${careless.state}`);
  assert(
    careless.phases[1].verdict === 'approved' &&
      careless.commits?.length === 1 &&
      careless.commits[0].subject === 'Fake change',
    `the careless review's commits are ${JSON.stringify(careless.commits)}`,
  );
  const diff = await call(`/api/runs/${careless.id}/diff?scope=run`);
  assert(
    diff.status === 200 && diff.body.files.map((file) => file.path).join() === 'FAKE_CHANGE.md',
    `the careless review's diff is ${JSON.stringify(diff.body?.files)}`,
  );
  const log = await call(`/api/runs/${careless.id}/events?limit=1000`);
  assert(
    log.body.events.some((event) =>
      event.text.startsWith('The review Phase changed the working copy; it was restored'),
    ),
    'the log does not say that the Working copy was restored',
  );

  const forgot = await finish(
    'Add a file [fake:commit] [fake-review:none]',
    'review without a Verdict',
  );
  assert(
    forgot.state === 'failed' &&
      forgot.failure?.code === 'agent_failed' &&
      forgot.failure.detail === 'The review Phase ended without a valid Verdict.' &&
      forgot.delivery !== 'delivered',
    `the Run of a review without a Verdict is ${forgot.state} ${JSON.stringify(forgot.failure)}`,
  );
  assert(
    forgot.phases[1].state === 'failed' && forgot.phases[1].verdict === null,
    `the Phase of a review without a Verdict is ${JSON.stringify(forgot.phases[1])}`,
  );
  console.log(
    '[e2e] review phase: "implement, then review" delivered after an approval and after changes requested (with the findings), never carried a careless review\'s edits into the pull request, and failed a review without a Verdict',
  );
}
