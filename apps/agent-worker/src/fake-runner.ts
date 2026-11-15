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
export const FAKE_SCENARIOS = ['success', 'fail', 'question', 'slow', 'crash'] as const;
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
}

/**
 * Runner with scripted outcomes (Issue #96): deterministic, no provider, no network.
 * - `success`: a done result with a pull request title and description and one check.
 * - `fail`: the agent fails ({@link AgentFailedError}).
 * - `question`: a `needs_input` result with a question.
 * - `slow`: keeps working for `slowMs`, then succeeds; stops when aborted.
 * - `crash`: the runner itself breaks (a plain error).
 * `resume` always succeeds.
 */
export class FakeRunner implements Runner {
  private readonly slowMs: number;

  constructor(options: FakeRunnerOptions = {}) {
    this.slowMs = options.slowMs ?? 60_000;
  }

  async *start({ run, signal }: StartRunStepInput): RunStep {
    const scenario = fakeScenarioOf(run.task);
    yield { type: 'status', text: `fake runner: ${scenario}` };
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
      case 'slow':
        yield { type: 'output', text: 'working slowly' };
        await delay(this.slowMs, undefined, { signal });
        return done();
      case 'success':
        yield { type: 'output', text: 'done' };
        return done();
    }
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
