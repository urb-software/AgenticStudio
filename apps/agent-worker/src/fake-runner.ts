import type { RunStepResult } from '@agentic-studio/contracts';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GIT_TIMEOUTS, GitRunner } from './git.js';
import {
  AgentFailedError,
  type ResumeRunStepInput,
  type Runner,
  type RunStep,
  type RunWorkspace,
  type StartRunStepInput,
} from './runner.js';

/** The scripted outcomes, chosen by a marker in the Task text (`[fake:<scenario>]`). */
export const FAKE_SCENARIOS = [
  'success',
  'fail',
  'question',
  'question-twice',
  'lost-session',
  'slow',
  'crash',
  'commit',
  'dirty',
  'stubborn',
  'checks-failed',
  'secret',
] as const;
export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

const MARKER = /\[fake:([a-z-]+)\]/;

/** The scenario a Task asks for; `success` without a (known) marker. */
export function fakeScenarioOf(task: string): FakeScenario {
  const named = MARKER.exec(task)?.[1];
  return (FAKE_SCENARIOS as readonly string[]).includes(named ?? '')
    ? (named as FakeScenario)
    : 'success';
}

export interface FakeRunnerOptions {
  /** How long the `slow` scenario works before it succeeds (it stops early when aborted). */
  slowMs?: number;
  /** How often the `slow` scenario prints a line while it works. */
  slowLineMs?: number;
  /** Git for the `commit` scenario (default: the worker's hardened runner). */
  git?: GitRunner;
}

/** The fake agent's session reference for a Run (Issue #103): deterministic, per Run. */
export function fakeSessionRef(runId: string): string {
  return `fake-session-${runId}`;
}

/** The fake agent's question (Issue #103), with options and a recommendation. */
function asking(runId: string, text: string): RunStepResult {
  return {
    outcome: 'needs_input',
    summary: 'The fake agent needs a decision.',
    question: { text, options: ['Option A', 'Option B'], recommendation: 'Option A' },
    sessionRef: fakeSessionRef(runId),
  };
}

/** The file the `commit` and `dirty` scenarios write in the Working copy. */
export const FAKE_CHANGE_FILE = 'FAKE_CHANGE.md';

/**
 * A token-shaped string for the `secret` scenario: GitHub's personal token shape, made of a
 * fixed pattern so it is obviously not a real token. Studio must redact it before storing.
 */
const FAKE_TOKEN = `ghp_${'fake0TOKEN0for0redaction0'.repeat(2).slice(0, 36)}`;

/**
 * Runner with scripted outcomes (Issue #96): deterministic, no provider, no network.
 * - `success`: a done result with a pull request title and description and one check; it
 *   changes nothing in the Working copy.
 * - `commit` (Issue #98): like `success`, after committing one new file on the Run branch.
 * - `dirty` (Issue #98): like `success`, leaving one new file uncommitted.
 * - `checks-failed` (Issue #102): like `commit`, but the agent reports a failing check.
 * - `fail`: the agent fails ({@link AgentFailedError}).
 * - `question` (Issue #103): a `needs_input` result with a question, two options and a
 *   recommendation, in the session {@link fakeSessionRef}; resumed, it succeeds.
 * - `question-twice`: like `question`, and the first resume asks a second question.
 * - `lost-session`: like `question`, but the session is gone when it is resumed (agent_failed).
 * - `slow`: prints a numbered line every `slowLineMs` for `slowMs` and one wide line,
 *   then succeeds; stops when aborted (the live-log smoke follows it, Issue #99).
 * - `secret` (Issue #99): prints a token-shaped string (redaction is proven end to end), then
 *   succeeds.
 * Each step streams an agent message, a command and its output, like a real agent.
 * - `stubborn` (Issue #100): like `slow`, but ignores the abort, so the worker must give up on
 *   it after the grace period (the hard path).
 * - `crash`: the runner itself breaks (a plain error).
 * `resume` checks that it continues the Run's own session and got an answer (else it fails as
 * the agent, like a provider without that session), then succeeds. It ignores the agent
 * definition.
 */
export class FakeRunner implements Runner {
  private readonly slowMs: number;
  private readonly slowLineMs: number;
  private readonly git: GitRunner;

  constructor(options: FakeRunnerOptions = {}) {
    this.slowMs = options.slowMs ?? 5000;
    this.slowLineMs = options.slowLineMs ?? 500;
    this.git = options.git ?? new GitRunner();
  }

  async *start({ run, workspace, signal }: StartRunStepInput): RunStep {
    const scenario = fakeScenarioOf(run.task);
    yield { type: 'message', text: `fake runner: ${scenario}` };
    if (scenario !== 'stubborn') signal.throwIfAborted();
    switch (scenario) {
      case 'fail':
        throw new AgentFailedError('The fake agent failed.');
      case 'crash':
        throw new Error('The fake runner crashed.');
      case 'question':
      case 'question-twice':
      case 'lost-session':
        return asking(run.runId, 'Which option should the fake agent take?');
      case 'slow': {
        yield { type: 'command', text: 'fake-work --slowly' };
        const started = Date.now();
        for (let line = 1; Date.now() - started < this.slowMs; line++) {
          yield { type: 'output', text: `working slowly: line ${line}` };
          await delay(this.slowLineMs, undefined, { signal });
        }
        // Wider than a phone: the log viewer scrolls it sideways, never the page.
        yield { type: 'output', text: `wide output: ${'0123456789'.repeat(30)}` };
        return done();
      }
      case 'secret':
        yield { type: 'command', text: 'printenv GITHUB_TOKEN' };
        yield { type: 'output', text: FAKE_TOKEN };
        return done();
      case 'stubborn':
        yield { type: 'output', text: 'working, and ignoring every request to stop' };
        // Deliberately no signal: the timer is unref'd so it never keeps the process alive.
        await delay(this.slowMs, undefined, { ref: false });
        return done();
      case 'commit':
        await this.change(workspace, signal, true);
        yield { type: 'output', text: `committed ${FAKE_CHANGE_FILE}` };
        return done();
      case 'dirty':
        await this.change(workspace, signal, false);
        yield { type: 'output', text: `left ${FAKE_CHANGE_FILE} uncommitted` };
        return done();
      case 'checks-failed':
        await this.change(workspace, signal, true);
        yield { type: 'output', text: `committed ${FAKE_CHANGE_FILE}; a check failed` };
        return {
          ...done(),
          checks: [
            { name: 'fake check', result: 'passed' },
            { name: 'fake unit tests', result: 'failed', detail: '1 of 12 tests failed.' },
          ],
        };
      case 'success':
        yield { type: 'command', text: 'fake-test --all' };
        yield { type: 'output', text: 'done' };
        return done();
    }
  }

  /** Writes the fake change into the Working copy and, if asked, commits it on the Run branch. */
  private async change(workspace: RunWorkspace, signal: AbortSignal, commit: boolean) {
    const file = join(workspace.repoDir, FAKE_CHANGE_FILE);
    // Repository content is untrusted: whatever is at that path (e.g. a symlink to a file
    // outside the Working copy) is removed, never written through, and a new file is created
    // exclusively (review of #117, S2).
    await rm(file, { force: true });
    await writeFile(file, 'Made by the fake runner.\n', { flag: 'wx', mode: 0o644 });
    if (!commit) return;
    const options = { cwd: workspace.repoDir, timeoutMs: GIT_TIMEOUTS.local, signal };
    await this.git.run(['add', '--', FAKE_CHANGE_FILE], options);
    await this.git.run(['commit', '--quiet', '--no-verify', '-m', 'Fake change'], options);
  }

  async *resume({ run, signal, answer, sessionRef }: ResumeRunStepInput): RunStep {
    const scenario = fakeScenarioOf(run.task);
    yield { type: 'message', text: 'fake runner: resume' };
    signal.throwIfAborted();
    if (scenario === 'lost-session' || sessionRef !== fakeSessionRef(run.runId)) {
      throw new AgentFailedError(
        'The fake agent cannot resume: the provider has no such session (its transcript is missing).',
      );
    }
    if (answer.trim() === '') throw new AgentFailedError('The fake agent got no answer.');
    yield { type: 'output', text: `answer received: ${answer}` };
    // The first resume of question-twice (its second Run step) asks again.
    if (scenario === 'question-twice' && run.completedSteps === 1) {
      return asking(run.runId, 'And which variant of it?');
    }
    return done();
  }
}

function done(): RunStepResult {
  return {
    outcome: 'done',
    summary: 'The fake agent finished the task.',
    pullRequest: { title: 'Fake change', body: 'Made by the fake runner.' },
    checks: [{ name: 'fake check', result: 'passed' }],
  };
}
