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
  integrationBranch: 'dev',
  kind: 'start',
});
// The scenarios here touch no Working copy (commit and dirty: fake-runner.linux.test.ts).
const workspace = { repoDir: '/nonexistent/repo', runDir: '/nonexistent', env: {} };

async function start(task: string, signal = new AbortController().signal, slowMs = 10) {
  const events: RunnerEvent[] = [];
  const result = await drainRunStep(
    new FakeRunner({ slowMs, slowLineMs: 2 }).start({ run: run(task), workspace, signal }),
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
    ['[fake:checks-failed] Add a file', 'checks-failed'],
    ['[fake:secret]', 'secret'],
    ['[fake:unknown]', 'success'],
  ])('reads %j as %s', (task, scenario) => {
    expect(fakeScenarioOf(task)).toBe(scenario);
  });
});

describe('FakeRunner', () => {
  it('succeeds with a valid done result after streaming a message, a command and output', async () => {
    const { events, result } = await start('Add a feature');

    expect(events.map((event) => event.type)).toEqual(['message', 'command', 'output']);
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

  it('works slowly, printing numbered lines over time, then succeeds (Issue #99)', async () => {
    const { events, result } = await start('[fake:slow]', undefined, 200);

    const lines = events.filter((event) => event.type === 'output').map((event) => event.text);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.slice(0, 2)).toEqual(['working slowly: line 1', 'working slowly: line 2']);
    expect(result.outcome).toBe('done');
  });

  it('prints a token-shaped string, to prove redaction end to end (Issue #99)', async () => {
    const { events, result } = await start('[fake:secret]');

    expect(events.some((event) => /\bghp_[A-Za-z0-9]{36}\b/.test(event.text))).toBe(true);
    expect(result.outcome).toBe('done');
  });

  it('stops a slow step when aborted', async () => {
    const abort = new AbortController();
    const pending = start('[fake:slow]', abort.signal, 60_000);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resumes with a done result', async () => {
    const result = await drainRunStep(
      new FakeRunner().resume({
        run: run('x'),
        workspace,
        answer: 'Option A',
        signal: new AbortController().signal,
      }),
      () => undefined,
    );
    expect(result.outcome).toBe('done');
  });
});
