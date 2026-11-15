import { runStepResultSchema, type RunnerEvent, type RunPayload } from '@agentic-studio/contracts';
import { describe, expect, it } from 'vitest';
import { FakeRunner, fakeScenarioOf } from '../fake-runner.js';
import { AgentFailedError, drainRunStep } from '../runner.js';

// Issue #96: the fake runner's scripted outcomes, through the runner interface.
const run = (task: string): RunPayload => ({
  runId: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
  projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
  provider: 'claude_code',
  task,
  startCommit: 'a'.repeat(40),
  repository: { remoteUrl: 'https://git.example.test/acme/shop.git' },
  limits: { stepMinutes: 60, maxSteps: 10 },
  completedSteps: 0,
});
const processes = { register: () => undefined };
// The scenarios here touch no Working copy (commit and dirty: fake-runner.linux.test.ts).
const workspace = { repoDir: '/nonexistent/repo', runDir: '/nonexistent', env: {} };

async function start(task: string, signal = new AbortController().signal, slowMs = 10) {
  const events: RunnerEvent[] = [];
  const result = await drainRunStep(
    new FakeRunner({ slowMs }).start({ run: run(task), workspace, signal, processes }),
    (event) => events.push(event),
  );
  return { events, result };
}

describe('fakeScenarioOf', () => {
  it.each([
    ['Add a feature', 'success'],
    ['[fake:fail] Add a feature', 'fail'],
    ['Please [fake:question]', 'question'],
    ['[fake:slow]', 'slow'],
    ['[fake:crash]', 'crash'],
    ['[fake:commit] Add a file', 'commit'],
    ['[fake:dirty]', 'dirty'],
    ['[fake:stubborn]', 'stubborn'],
    ['[fake:unknown]', 'success'],
  ])('reads %j as %s', (task, scenario) => {
    expect(fakeScenarioOf(task)).toBe(scenario);
  });
});

describe('FakeRunner', () => {
  it('succeeds with a valid done result after streaming events', async () => {
    const { events, result } = await start('Add a feature');

    expect(events.length).toBeGreaterThan(0);
    expect(runStepResultSchema.parse(result)).toMatchObject({
      outcome: 'done',
      pullRequest: { title: 'Fake change' },
    });
  });

  it('asks a question with a needs_input result', async () => {
    const { result } = await start('[fake:question]');

    expect(runStepResultSchema.parse(result)).toMatchObject({
      outcome: 'needs_input',
      question: expect.any(String),
    });
  });

  it('fails as the agent', async () => {
    await expect(start('[fake:fail]')).rejects.toBeInstanceOf(AgentFailedError);
  });

  it('crashes as a plain error', async () => {
    const failure = await start('[fake:crash]').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AgentFailedError);
  });

  it('works slowly, then succeeds', async () => {
    const { result } = await start('[fake:slow]');
    expect(result.outcome).toBe('done');
  });

  it('stops a slow step when aborted', async () => {
    const abort = new AbortController();
    const pending = start('[fake:slow]', abort.signal, 60_000);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps a stubborn step going when aborted (Issue #100: the hard path)', async () => {
    const abort = new AbortController();
    const pending = start('[fake:stubborn]', abort.signal, 50);
    abort.abort();
    expect((await pending).result.outcome).toBe('done');
  });

  it('resumes with a done result', async () => {
    const result = await drainRunStep(
      new FakeRunner().resume({
        run: run('x'),
        workspace,
        answer: 'Option A',
        signal: new AbortController().signal,
        processes,
      }),
      () => undefined,
    );
    expect(result.outcome).toBe('done');
  });
});
