// The send-back phase of the smoke test, on Linux: Workflows with a review Phase carried out by the
// agent worker's fake runner. Changes requested go back to the work Phase, within the Workflow's
// limit, and a review can sit beside a Checkpoint. Everything goes through the operator routes.
import { setTimeout as delay } from 'node:timers/promises';

/** "Implement, then review" that allows no send-back: changes requested end it. */
export const STRICT_REVIEW_FILE =
  '---\nname: strict-review\ndescription: Implement, then review, never send back\nsend-backs: 0\nsequence:\n' +
  '  - id: implement\n    kind: work\n    agent: helper\n' +
  '  - id: review\n    kind: review\n    agent: reviewer\n---\nNotes for the operator.\n';

/** A review, then a Checkpoint, then more work. */
export const REVIEW_THEN_LOOK_FILE =
  '---\nname: review-then-look\ndescription: Implement, review, wait for the operator, polish\nsequence:\n' +
  '  - id: implement\n    kind: work\n    agent: helper\n' +
  '  - id: review\n    kind: review\n    agent: reviewer\n' +
  '  - id: look\n    kind: checkpoint\n    text: Read the review before the polish.\n' +
  '  - id: polish\n    kind: work\n    agent: helper\n---\nNotes for the operator.\n';

const FINAL_STATES = ['succeeded', 'failed', 'cancelled', 'timed_out'];

async function until(read, done, what, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `send-back phase: timed out waiting for ${what}; last: ${JSON.stringify(value)}`,
      );
    }
    await delay(250);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`send-back phase: ${message}`);
}

/**
 * @param {object} options
 * @param {(path: string, init?: object) => Promise<{ status: number, body: any }>} options.call
 *   an operator call (logged in)
 * @param {string} options.projectId a Project with a ready Repository
 */
export async function runSendBackPhase({ call, projectId }) {
  const start = async (task, workflow) => {
    const started = await call(`/api/projects/${projectId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ task, workflow }),
    });
    assert(started.status === 201, `starting the ${workflow} Run answered ${started.status}`);
    return started.body.id;
  };
  const read = async (runId) => (await call(`/api/runs/${runId}`)).body;
  const finish = (runId, what) =>
    until(
      () => read(runId),
      (run) => FINAL_STATES.includes(run.state),
      what,
    );
  const logOf = async (runId) =>
    (await call(`/api/runs/${runId}/events?limit=1000`)).body.events.map((event) => event.text);
  const post = (runId, action, body) =>
    call(`/api/runs/${runId}/checkpoint/${action}`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });

  // Changes requested once, then approved: the work went back, the review ran again, and the
  // pull request was delivered once.
  const once = await finish(
    await start('Add a file [fake:commit] [fake-review:changes-once]', 'implement-review'),
    'the send-back Run to finish',
  );
  assert(once.state === 'succeeded', `the send-back Run is ${once.state}`);
  assert(
    once.sendBacks?.used === 1 && once.sendBacks.limit === 2,
    `the send-backs are ${JSON.stringify(once.sendBacks)}`,
  );
  const [work, review] = once.phases;
  assert(
    work.rounds.length === 2 && review.rounds.length === 2,
    `the rounds are ${JSON.stringify(once.phases.map((phase) => phase.rounds.length))}`,
  );
  assert(
    review.rounds[0].verdict === 'changes_requested' &&
      review.rounds[0].findings.length === 2 &&
      review.rounds[1].verdict === 'approved' &&
      review.verdict === 'approved',
    `the review's rounds are ${JSON.stringify(review.rounds)}`,
  );
  assert(
    work.rounds.every((round) => typeof round.summary === 'string'),
    `the work Phase's rounds are ${JSON.stringify(work.rounds)}`,
  );
  assert(once.reviewNotPassed === false, 'the Run says its review did not pass');
  assert(
    once.delivery === 'delivered' && once.pullRequest?.number >= 1,
    `the send-back Run delivered ${once.delivery} with ${JSON.stringify(once.pullRequest)}`,
  );
  assert(
    once.commits?.some((commit) => commit.subject === 'Fake follow-up change'),
    `the work Phase did not work again: ${JSON.stringify(once.commits)}`,
  );
  const onceLog = await logOf(once.id);
  for (const expected of [
    'Changes requested: back to implement, round 1 of 2',
    'fake runner: send-back',
    'fake runner: send-back round 1 of 2',
    'fake runner: told by the review: FAKE_CHANGE.md:1: The fake review found a problem here.',
  ]) {
    assert(onceLog.includes(expected), `the log lacks "${expected}": ${JSON.stringify(onceLog)}`);
  }
  assert(
    onceLog.filter((text) => text === 'Phase review (2/2) ended: done, approved').length === 1 &&
      onceLog.filter((text) => text === 'Phase review (2/2) ended: done, changes requested')
        .length === 1,
    'the review did not run twice, once with each Verdict',
  );

  // Changes requested every time: the limit ends it as "review not passed", the pull request is
  // delivered, and the open findings of the last review are shown.
  const limited = await finish(
    await start('Add a file [fake:commit] [fake-review:changes]', 'implement-review'),
    'the Run that reaches the limit to finish',
  );
  assert(limited.state === 'succeeded', `the Run at the limit is ${limited.state}`);
  assert(
    limited.sendBacks?.used === 2 && limited.sendBacks.limit === 2,
    `the send-backs at the limit are ${JSON.stringify(limited.sendBacks)}`,
  );
  assert(
    limited.phases[1].rounds.length === 3 &&
      limited.phases[1].rounds.every((round) => round.verdict === 'changes_requested') &&
      limited.phases[1].findings.length === 2,
    `the review at the limit is ${JSON.stringify(limited.phases[1])}`,
  );
  assert(limited.reviewNotPassed === true, 'the Run at the limit does not say review not passed');
  assert(
    limited.delivery === 'delivered' && limited.pullRequest?.number >= 1,
    `the Run at the limit delivered ${limited.delivery}`,
  );
  const limitedLog = await logOf(limited.id);
  assert(
    limitedLog.includes('Changes requested: back to implement, round 2 of 2') &&
      !limitedLog.some((text) => text.includes('round 3 of 2')),
    'the log does not mark the two send-backs and no more',
  );

  // A Workflow that lowers the limit to none: changes requested end it at once.
  const strict = await finish(
    await start('Add a file [fake:commit] [fake-review:changes]', 'strict-review'),
    'the strict Run to finish',
  );
  assert(
    strict.state === 'succeeded' &&
      strict.sendBacks?.used === 0 &&
      strict.sendBacks.limit === 0 &&
      strict.phases[1].rounds.length === 1 &&
      strict.reviewNotPassed === true &&
      strict.delivery === 'delivered',
    `the strict Run is ${strict.state} with ${JSON.stringify(strict.sendBacks)}`,
  );

  // A Run started with an agent has no send-backs to show.
  const plain = (await call(`/api/projects/${projectId}/runs`)).body;
  assert(
    plain.every((run) => run.sendBacks === undefined),
    'a list of Runs shows the send-backs',
  );

  // A review followed by a Checkpoint: an approval hands on to it, and the Run waits there.
  const looked = await start('Add a file [fake:dirty] [fake-review:approved]', 'review-then-look');
  const waiting = await until(
    () => read(looked),
    (run) => run.state === 'waiting_for_operator' || FINAL_STATES.includes(run.state),
    'the Run to reach the Checkpoint after the review',
  );
  assert(
    waiting.state === 'waiting_for_operator' &&
      waiting.waiting?.reason === 'checkpoint' &&
      waiting.waiting.checkpoint.id === 'look',
    `the Run waits as ${waiting.state} ${JSON.stringify(waiting.waiting)}`,
  );
  assert(
    waiting.phases.map((phase) => phase.state).join() === 'done,done,pending' &&
      waiting.phases[1].verdict === 'approved' &&
      waiting.pullRequest === undefined,
    `the Phases at the Checkpoint are ${JSON.stringify(waiting.phases)}`,
  );
  assert(
    (await post(looked, 'continue', { checkpoint: 'look' })).status === 202,
    'Continue failed',
  );
  const polished = await finish(looked, 'the Run to finish after Continue');
  assert(
    polished.state === 'succeeded' &&
      polished.phases.every((phase) => phase.state === 'done') &&
      polished.delivery === 'delivered' &&
      polished.pullRequest?.number >= 1,
    `the Run after the Checkpoint is ${polished.state} with ${polished.delivery}`,
  );

  // Stop at the Checkpoint right after a review that changed the Working copy: the Working copy
  // was restored first, and the delivery holds only the work Phase's change, described by its summary.
  const stopped = await start('Add a file [fake:dirty] [fake-review:edits]', 'review-then-look');
  await until(
    () => read(stopped),
    (run) => run.state === 'waiting_for_operator' || FINAL_STATES.includes(run.state),
    'the careless Run to reach the Checkpoint',
  );
  assert((await post(stopped, 'stop', { checkpoint: 'look' })).status === 202, 'Stop failed');
  const stoppedRun = await finish(stopped, 'the stopped Run to finish');
  assert(
    stoppedRun.state === 'succeeded' &&
      stoppedRun.delivery === 'delivered' &&
      stoppedRun.commits?.length === 1 &&
      stoppedRun.commits[0].subject.includes('The fake agent finished the task. (Phase implement)'),
    `the stopped Run is ${stoppedRun.state} with ${JSON.stringify(stoppedRun.commits)}`,
  );
  const diff = await call(`/api/runs/${stopped}/diff?scope=run`);
  assert(
    diff.status === 200 && diff.body.files.map((file) => file.path).join() === 'FAKE_CHANGE.md',
    `the stopped Run's diff is ${JSON.stringify(diff.body?.files)}`,
  );
  assert(
    (await logOf(stopped)).some((text) =>
      text.startsWith('The review Phase changed the working copy; it was restored'),
    ),
    'the log does not say that the Working copy was restored',
  );
  console.log(
    '[e2e] send-back phase: changes requested went back to the work Phase and the review ran again (once, then approved; until the limit, then delivered as review not passed; never with a limit of none), and a review beside a Checkpoint handed on and stopped as before',
  );
}
