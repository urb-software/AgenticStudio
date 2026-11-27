// The Checkpoint phase of the smoke test, on Linux: a Workflow with a Checkpoint between two work
// Phases, carried out by the agent worker's fake runner. Everything goes through the operator
// routes: the Run waits for the operator, which continues with a comment the second Phase logs,
// stops (with and without a change in the Working copy) or cancels.
import { setTimeout as delay } from 'node:timers/promises';

/** A Workflow that waits for the operator between its two work Phases. */
export const PLAN_THEN_BUILD_FILE =
  '---\nname: plan-then-build\ndescription: Work, wait for the operator, work\nsequence:\n' +
  '  - id: plan\n    kind: work\n    agent: reviewer\n' +
  '  - id: look\n    kind: checkpoint\n    text: Read what the first Phase did before it goes on.\n' +
  '  - id: build\n    kind: work\n    agent: helper\n---\nNotes for the operator.\n';

const FINAL_STATES = ['succeeded', 'failed', 'cancelled', 'timed_out'];

async function until(read, done, what, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `checkpoint phase: timed out waiting for ${what}; last: ${JSON.stringify(value)}`,
      );
    }
    await delay(250);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`checkpoint phase: ${message}`);
}

/**
 * @param {object} options
 * @param {(path: string, init?: object) => Promise<{ status: number, body: any }>} options.call
 *   an operator call (logged in)
 * @param {string} options.projectId a Project with a ready Repository
 */
export async function runCheckpointPhase({ call, projectId }) {
  const start = async (task) => {
    const started = await call(`/api/projects/${projectId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ task, workflow: 'plan-then-build' }),
    });
    assert(started.status === 201, `starting the Checkpoint Run answered ${started.status}`);
    return started.body.id;
  };
  const read = async (runId) => (await call(`/api/runs/${runId}`)).body;
  const atCheckpoint = (runId) =>
    until(
      () => read(runId),
      (run) => run.state === 'waiting_for_operator' || FINAL_STATES.includes(run.state),
      'the Run to reach the Checkpoint',
    );
  const finish = (runId, what) =>
    until(
      () => read(runId),
      (run) => FINAL_STATES.includes(run.state),
      what,
    );
  const post = (runId, action, body) =>
    call(`/api/runs/${runId}/checkpoint/${action}`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });
  const logOf = async (runId) =>
    (await call(`/api/runs/${runId}/events?limit=1000`)).body.events.map((event) => event.text);

  // Work, Checkpoint, work: the first Phase hands the Working copy on, and the Run waits.
  const first = await start('Plan, wait for me, build [fake:dirty]');
  const waiting = await atCheckpoint(first);
  assert(waiting.state === 'waiting_for_operator', `the Run is ${waiting.state} at the Checkpoint`);
  assert(
    waiting.waiting?.reason === 'checkpoint' &&
      waiting.waiting.checkpoint.id === 'look' &&
      waiting.waiting.checkpoint.text === 'Read what the first Phase did before it goes on.',
    `the Run waits as ${JSON.stringify(waiting.waiting)}`,
  );
  assert(waiting.question === undefined, 'a Run at a Checkpoint shows a Question');
  assert(
    waiting.phases.map((phase) => phase.state).join() === 'done,pending' &&
      waiting.phases[0].summary === 'The fake agent finished the task. (Phase plan)',
    `the Phases are ${JSON.stringify(waiting.phases)}`,
  );
  assert(waiting.pullRequest === undefined, 'a pull request was opened before the Checkpoint');
  const listed = (await call('/api/runs')).body.find((run) => run.id === first);
  assert(
    listed?.waiting?.reason === 'checkpoint' && listed.waiting.checkpoint.id === 'look',
    `the Runs list shows ${JSON.stringify(listed?.waiting)}`,
  );
  assert(
    !(await logOf(first)).some((text) => text.startsWith('Phase build')),
    'the Phase after the Checkpoint started without the operator',
  );

  // Continue with a comment; refused for another Checkpoint and for a comment that is too long.
  const wrong = await post(first, 'continue', { checkpoint: 'elsewhere' });
  assert(
    wrong.status === 409 && wrong.body.reason === 'not_at_checkpoint',
    `a wrong Checkpoint answered ${wrong.status} ${JSON.stringify(wrong.body)}`,
  );
  const long = await post(first, 'continue', { comment: 'x'.repeat(4001) });
  assert(long.status === 422, `a comment of 4,001 characters answered ${long.status}`);
  const note = 'Use the small plan, and keep the diff short.';
  const proceeded = await post(first, 'continue', { comment: note, checkpoint: 'look' });
  assert(
    proceeded.status === 202 && proceeded.body.id === first,
    `continuing answered ${proceeded.status} ${JSON.stringify(proceeded.body)}`,
  );
  assert(proceeded.body.waiting === undefined, 'the answer still says the Run waits');
  const again = await post(first, 'continue', { checkpoint: 'look' });
  assert(
    again.status === 409 && again.body.reason === 'not_at_checkpoint',
    `a second Continue answered ${again.status}`,
  );
  const done = await finish(first, 'the Run to finish after Continue');
  assert(done.state === 'succeeded', `the Run is ${done.state} after Continue`);
  assert(
    done.phases.every((phase) => phase.state === 'done'),
    `the Phases ended as ${JSON.stringify(done.phases)}`,
  );
  assert(
    done.delivery === 'delivered' && done.pullRequest?.number >= 1 && done.commits?.length === 1,
    `the Run delivered ${done.delivery} with ${JSON.stringify(done.commits)}`,
  );
  const texts = await logOf(first);
  const told = 'fake runner: told by phase plan: The fake agent finished the task. (Phase plan)';
  const operator = `fake runner: told by the operator: ${note}`;
  assert(
    texts.includes(told) && texts.includes(operator),
    `the second Phase was not told the comment: ${JSON.stringify(texts)}`,
  );
  assert(
    texts.indexOf(operator) > texts.indexOf(told),
    'the comment did not come after what the Phase before reported',
  );
  const gone = await post(first, 'continue');
  assert(gone.status === 409, `a Continue after the end answered ${gone.status}`);

  // Stop here with a change in the Working copy: delivers what exists, once, and ends.
  const stopped = await start('Plan, then stop [fake:dirty]');
  await atCheckpoint(stopped);
  const stopAnswer = await post(stopped, 'stop', { checkpoint: 'look' });
  assert(stopAnswer.status === 202, `stopping answered ${stopAnswer.status}`);
  const stoppedRun = await finish(stopped, 'the stopped Run to finish');
  assert(stoppedRun.state === 'succeeded', `the stopped Run is ${stoppedRun.state}`);
  assert(
    stoppedRun.delivery === 'delivered' &&
      stoppedRun.pullRequest?.number >= 1 &&
      stoppedRun.commits?.length === 1 &&
      stoppedRun.commits[0].pushed === true,
    `the stopped Run delivered ${stoppedRun.delivery} with ${JSON.stringify(stoppedRun.commits)}`,
  );
  assert(
    stoppedRun.phases.map((phase) => phase.state).join() === 'done,pending',
    `the stopped Run's Phases are ${JSON.stringify(stoppedRun.phases)}`,
  );
  assert(
    !(await logOf(stopped)).some((text) => text.startsWith('Phase build')),
    'the Phase after the Checkpoint ran after Stop',
  );
  assert((await post(stopped, 'stop')).status === 409, 'a second Stop was not refused');

  // Stop here with no change: the Run finishes without a pull request.
  const clean = await start('Plan, then stop, with nothing changed');
  await atCheckpoint(clean);
  assert((await post(clean, 'stop')).status === 202, 'stopping a clean Run was refused');
  const cleanRun = await finish(clean, 'the clean stopped Run to finish');
  assert(
    cleanRun.state === 'succeeded' &&
      cleanRun.delivery === 'none' &&
      cleanRun.pullRequest === undefined,
    `the clean stopped Run is ${cleanRun.state} with ${cleanRun.delivery} ${JSON.stringify(cleanRun.pullRequest)}`,
  );

  // Cancel at the Checkpoint: nothing is pushed, and Continue is then refused.
  const cancelled = await start('Plan, then cancel [fake:dirty]');
  await atCheckpoint(cancelled);
  const cancelAnswer = await call(`/api/runs/${cancelled}/cancel`, { method: 'POST' });
  assert(cancelAnswer.status === 202, `cancelling answered ${cancelAnswer.status}`);
  const cancelledRun = await read(cancelled);
  assert(
    cancelledRun.state === 'cancelled' &&
      cancelledRun.pullRequest === undefined &&
      cancelledRun.delivery === undefined,
    `the cancelled Run is ${cancelledRun.state} with ${cancelledRun.delivery}`,
  );
  assert(
    (await post(cancelled, 'continue')).status === 409,
    'a Continue after the cancel was not refused',
  );
  console.log(
    '[e2e] checkpoint phase: a Run waited at a Checkpoint between two work Phases; Continue passed the operator comment to the second Phase, Stop delivered what existed (or nothing), repeats and a cancel were refused',
  );
}
