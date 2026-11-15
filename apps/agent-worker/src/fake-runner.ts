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
  'slow',
  'crash',
  'commit',
  'dirty',
  'stubborn',
] as const;
export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

const MARKER = /\[fake:([a-z]+)\]/;

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
  /** Git for the `commit` scenario (default: the worker's hardened runner). */
  git?: GitRunner;
}

/** The file the `commit` and `dirty` scenarios write in the Working copy. */
export const FAKE_CHANGE_FILE = 'FAKE_CHANGE.md';

/**
 * Runner with scripted outcomes (Issue #96): deterministic, no provider, no network.
 * - `success`: a done result with a pull request title and description and one check; it
 *   changes nothing in the Working copy.
 * - `commit` (Issue #98): like `success`, after committing one new file on the Run branch.
 * - `dirty` (Issue #98): like `success`, leaving one new file uncommitted.
 * - `fail`: the agent fails ({@link AgentFailedError}).
 * - `question`: a `needs_input` result with a question.
 * - `slow`: keeps working for `slowMs`, then succeeds; stops when aborted.
 * - `stubborn` (Issue #100): like `slow`, but ignores the abort, so the worker must give up on
 *   it after the grace period (the hard path).
 * - `crash`: the runner itself breaks (a plain error).
 * `resume` always succeeds.
 */
export class FakeRunner implements Runner {
  private readonly slowMs: number;
  private readonly git: GitRunner;

  constructor(options: FakeRunnerOptions = {}) {
    this.slowMs = options.slowMs ?? 60_000;
    this.git = options.git ?? new GitRunner();
  }

  async *start({ run, workspace, signal }: StartRunStepInput): RunStep {
    const scenario = fakeScenarioOf(run.task);
    yield { type: 'status', text: `fake runner: ${scenario}` };
    if (scenario !== 'stubborn') signal.throwIfAborted();
    switch (scenario) {
      case 'fail':
        throw new AgentFailedError('The fake agent failed.');
      case 'crash':
        throw new Error('The fake runner crashed.');
      case 'question':
        return {
          outcome: 'needs_input',
          summary: 'The fake agent needs a decision.',
          question: 'Which option should the fake agent take?',
        };
      case 'slow':
        yield { type: 'output', text: 'working slowly' };
        await delay(this.slowMs, undefined, { signal });
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
      case 'success':
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

  async *resume({ signal }: ResumeRunStepInput): RunStep {
    yield { type: 'status', text: 'fake runner: resume' };
    signal.throwIfAborted();
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
