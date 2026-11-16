import {
  type ResumeReason,
  runStepResultSchema,
  type RunnerEvent,
  type RunPayload,
} from '@agentic-studio/contracts';
import { describe, expect, it } from 'vitest';
import { AGENT_DEFINITION } from '../agent-definition/index.js';
import { FakeRunner, fakeScenarioOf, fakeSessionRef } from '../fake-runner.js';
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
  integrationBranch: 'dev',
  kind: 'start',
  studioPaths: [],
});
const processes = { register: () => undefined };
// The scenarios here touch no Working copy (commit and dirty: fake-runner.linux.test.ts).
const workspace = { repoDir: '/nonexistent/repo', runDir: '/nonexistent', env: {} };

async function start(task: string, signal = new AbortController().signal, slowMs = 10) {
  const events: RunnerEvent[] = [];
  const result = await drainRunStep(
    new FakeRunner({ slowMs, slowLineMs: 2 }).start({
      run: run(task),
      workspace,
      signal,
      processes,
      agentDefinition: AGENT_DEFINITION,
    }),
    (event) => events.push(event),
  );
  return { events, result };
}

describe('fakeScenarioOf', () => {
  it.each([
    ['Add a feature', 'success'],
    ['[fake:fail] Add a feature', 'fail'],
    ['Please [fake:question]', 'question'],
    ['[fake:question-twice]', 'question-twice'],
    ['[fake:lost-session]', 'lost-session'],
    ['[fake:slow]', 'slow'],
    ['[fake:crash]', 'crash'],
    ['[fake:commit] Add a file', 'commit'],
    ['[fake:dirty]', 'dirty'],
    ['[fake:stubborn]', 'stubborn'],
    ['[fake:long]', 'long'],
    ['[fake:checks-failed] Add a file', 'checks-failed'],
    ['[fake:secret]', 'secret'],
    ['Print it [fake:print-env]', 'print-env'],
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

  it('asks a question with options and a recommendation, in a session of its own (Issue #103)', async () => {
    const { result } = await start('[fake:question]');

    expect(runStepResultSchema.parse(result)).toMatchObject({
      outcome: 'needs_input',
      question: {
        text: expect.any(String),
        options: expect.arrayContaining([expect.any(String)]),
        recommendation: expect.any(String),
      },
      sessionRef: fakeSessionRef(run('x').runId),
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

  it('works on a long step until it is aborted (Issue #100: a Run to cancel)', async () => {
    const abort = new AbortController();
    const pending = start('[fake:long]', abort.signal, 10);
    setTimeout(() => abort.abort(), 30);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps a stubborn step going when aborted (Issue #100: the hard path)', async () => {
    const abort = new AbortController();
    const pending = start('[fake:stubborn]', abort.signal, 50);
    abort.abort();
    expect((await pending).result.outcome).toBe('done');
  });

  // Issue #103: what a runner must do on resume, proven with the fake runner.
  describe('resume (Issue #103)', () => {
    const resume = (
      task: string,
      sessionRef: string,
      completedSteps = 1,
      answer = 'Option A',
      reason: ResumeReason = 'answer',
    ) => {
      const events: RunnerEvent[] = [];
      return drainRunStep(
        new FakeRunner().resume({
          run: { ...run(task), completedSteps },
          workspace,
          answer,
          reason,
          sessionRef,
          signal: new AbortController().signal,
          processes,
          agentDefinition: AGENT_DEFINITION,
        }),
        (event) => events.push(event),
      ).then((result) => ({ result, events }));
    };
    const SESSION = fakeSessionRef(run('x').runId);

    it('continues the same session with the answer, to a done result', async () => {
      const { result, events } = await resume('[fake:question]', SESSION);

      expect(result.outcome).toBe('done');
      expect(events.map((event) => event.text)).toContain('answer received: Option A');
    });

    it('refuses a session it did not start, as the agent (the provider has no such session)', async () => {
      await expect(resume('[fake:question]', 'another-session')).rejects.toBeInstanceOf(
        AgentFailedError,
      );
    });

    it('asks again on the first resume of question-twice, then finishes on the next', async () => {
      const first = await resume('[fake:question-twice]', SESSION, 1);
      expect(runStepResultSchema.parse(first.result)).toMatchObject({
        outcome: 'needs_input',
        sessionRef: SESSION,
      });
      expect((await resume('[fake:question-twice]', SESSION, 2)).result.outcome).toBe('done');
    });

    describe('a Follow-up (Issue #141)', () => {
      it('plays the scenario its own text names, in the same session', async () => {
        const { result, events } = await resume(
          'Add a feature',
          SESSION,
          1,
          'Also log it',
          'follow_up',
        );
        expect(result.outcome).toBe('done');
        expect(events.map((event) => event.text)).toEqual(
          expect.arrayContaining(['fake runner: follow-up', 'follow-up received: success']),
        );

        const asked = await resume('Add a feature', SESSION, 1, '[fake:question] Hm', 'follow_up');
        expect(runStepResultSchema.parse(asked.result)).toMatchObject({
          outcome: 'needs_input',
          sessionRef: SESSION,
        });
        await expect(
          resume('Add a feature', SESSION, 1, '[fake:fail] Break', 'follow_up'),
        ).rejects.toBeInstanceOf(AgentFailedError);
      });

      it('refuses a session it did not start', async () => {
        await expect(
          resume('Add a feature', 'another-session', 1, 'More', 'follow_up'),
        ).rejects.toBeInstanceOf(AgentFailedError);
      });
    });

    describe('a bring-up-to-date request (Issue #147)', () => {
      it('plays the scenario the instruction names, success by default, in the same session', async () => {
        const { result, events } = await resume(
          'Add a feature',
          SESSION,
          1,
          'The merge commit exists.',
          'bring_up_to_date',
        );
        expect(result.outcome).toBe('done');
        expect(events.map((event) => event.text)).toContain('bring-up received: success');
        await expect(
          resume('Add a feature', SESSION, 1, 'Note: [fake:fail] Break', 'bring_up_to_date'),
        ).rejects.toBeInstanceOf(AgentFailedError);
      });
    });

    it('cannot resume a lost session: the provider refuses it', async () => {
      const { result } = await start('[fake:lost-session]');
      expect(result.outcome).toBe('needs_input');

      const refused = await resume('[fake:lost-session]', SESSION).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(AgentFailedError);
      expect((refused as Error).message).toMatch(/session/);
    });
  });
});
