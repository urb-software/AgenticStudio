import type { RunStepResult } from '@agentic-studio/contracts';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AgentFailedError,
  type ResumeRunStepInput,
  type Runner,
  type RunStep,
  type StartRunStepInput,
} from './runner.js';

/** The scripted outcomes, chosen by a marker in the Task text (`[fake:<scenario>]`). */
export const FAKE_SCENARIOS = ['success', 'fail', 'question', 'slow', 'crash', 'secret'] as const;
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
  /** How often the `slow` scenario prints a line while it works. */
  slowLineMs?: number;
}

/**
 * A token-shaped string for the `secret` scenario: GitHub's personal token shape, made of a
 * fixed pattern so it is obviously not a real token. Studio must redact it before storing.
 */
const FAKE_TOKEN = `ghp_${'fake0TOKEN0for0redaction0'.repeat(2).slice(0, 36)}`;

/**
 * Runner with scripted outcomes (Issues #96, #99): deterministic, no provider, no network.
 * Each step streams an agent message, a command and its output, like a real agent.
 * - `success`: a done result with a pull request title and description and one check.
 * - `fail`: the agent fails ({@link AgentFailedError}).
 * - `question`: a `needs_input` result with a question.
 * - `slow`: prints a numbered line every `slowLineMs` for `slowMs` and one wide line, then
 *   succeeds; stops when aborted (the live-log smoke follows it).
 * - `crash`: the runner itself breaks (a plain error).
 * - `secret`: prints a token-shaped string (redaction is proven end to end), then succeeds.
 * `resume` always succeeds.
 */
export class FakeRunner implements Runner {
  private readonly slowMs: number;
  private readonly slowLineMs: number;

  constructor(options: FakeRunnerOptions = {}) {
    this.slowMs = options.slowMs ?? 5000;
    this.slowLineMs = options.slowLineMs ?? 500;
  }

  async *start({ run, signal }: StartRunStepInput): RunStep {
    const scenario = fakeScenarioOf(run.task);
    yield { type: 'message', text: `fake runner: ${scenario}` };
    signal.throwIfAborted();
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
      case 'success':
        yield { type: 'command', text: 'fake-test --all' };
        yield { type: 'output', text: 'done' };
        return done();
    }
  }

  async *resume({ signal }: ResumeRunStepInput): RunStep {
    yield { type: 'message', text: 'fake runner: resume' };
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
