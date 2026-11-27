import {
  type ResumeReason,
  runStepResultSchema,
  type RunnerEvent,
  type RunPayload,
} from '@agentic-studio/contracts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FAKE_REVIEW_FINDINGS,
  FakeRunner,
  fakeAgentLine,
  fakeReviewScenarioOf,
  fakeScenarioOf,
  fakeSessionRef,
} from '../fake-runner.js';
import { AgentFailedError, drainRunStep } from '../runner.js';
import { agentFields } from './agent-fixtures.js';

const run = (task: string): RunPayload => ({
  runId: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
  projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
  provider: 'claude_code',
  ...agentFields('claude_code'),
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
    ['[fake:copy-agent-file]', 'copy-agent-file'],
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

  it('asks a question with options and a recommendation, in a session of its own', async () => {
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

  it('works slowly, printing numbered lines over time, then succeeds', async () => {
    const { events, result } = await start('[fake:slow]', undefined, 200);

    const lines = events.filter((event) => event.type === 'output').map((event) => event.text);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.slice(0, 2)).toEqual(['working slowly: line 1', 'working slowly: line 2']);
    expect(result.outcome).toBe('done');
  });

  it('prints a token-shaped string, to prove redaction end to end', async () => {
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

  it('works on a long step until it is aborted', async () => {
    const abort = new AbortController();
    const pending = start('[fake:long]', abort.signal, 10);
    setTimeout(() => abort.abort(), 30);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps a stubborn step going when aborted', async () => {
    const abort = new AbortController();
    const pending = start('[fake:stubborn]', abort.signal, 50);
    abort.abort();
    expect((await pending).result.outcome).toBe('done');
  });

  describe('resume', () => {
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

    describe('a Follow-up', () => {
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

    describe('a bring-up-to-date request', () => {
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

describe('the agent the fake runner records', () => {
  const INSTRUCTIONS = 'Review every change twice.\n';
  const fields = agentFields('claude_code');
  const reviewer = (task: string): RunPayload => ({
    ...run(task),
    agent: {
      ...fields.agent,
      name: 'reviewer',
      source: 'definitions',
      commit: 'c'.repeat(40),
      model: 'opus',
      instructions: INSTRUCTIONS,
    },
  });
  const startWith = async (payload: RunPayload) => {
    const events: RunnerEvent[] = [];
    await drainRunStep(
      new FakeRunner().start({
        run: payload,
        workspace,
        signal: new AbortController().signal,
        processes,
      }),
      (event) => events.push(event),
    );
    return events.map((event) => event.text);
  };

  it('logs the commit, the base rules version and the size and digest of the instructions, never their text', () => {
    const line = fakeAgentLine(reviewer('x'));

    expect(line).toBe(
      `fake runner: agent reviewer at ${'c'.repeat(40)}, model opus; ` +
        `base rules ${fields.baseRules.version}; instructions ${INSTRUCTIONS.length} bytes, ` +
        `sha256 ${createHash('sha256').update(INSTRUCTIONS).digest('hex')}`,
    );
    expect(line).not.toContain('Review every');
  });

  it('puts that line right after the scenario line of a start, and nothing else changes', async () => {
    const texts = await startWith(reviewer('Add a feature'));

    expect(texts[0]).toBe('fake runner: success');
    expect(texts[1]).toBe(fakeAgentLine(reviewer('x')));
    expect(texts.slice(2)).toEqual((await startWith(run('Add a feature'))).slice(1));
  });

  it('logs nothing for the built-in Default agent, so its Runs log what they always did', async () => {
    expect(fakeAgentLine(run('x'))).toBeNull();
    expect((await startWith(run('x'))).filter((text) => text.includes('agent'))).toEqual([]);
  });
});

describe('the fake runner and the agent folder', () => {
  const reviewerRun = (task: string): RunPayload => ({
    ...run(task),
    agent: {
      ...run(task).agent,
      name: 'reviewer',
      source: 'definitions',
      commit: 'c'.repeat(40),
      instructions: 'Review.',
    },
  });

  async function startWithFolder(dir: string | null, task = 'Add a feature') {
    const events: RunnerEvent[] = [];
    await drainRunStep(
      new FakeRunner({ slowMs: 10, slowLineMs: 2 }).start({
        run: reviewerRun(task),
        workspace: { ...workspace, ...(dir === null ? {} : { agentFolder: dir }) },
        signal: new AbortController().signal,
        processes,
      }),
      (event) => events.push(event),
    );
    return events;
  }

  it('reports the files of the folder by path, mode and digest, never their content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-fake-agent-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'scripts', 'check.sh'), '#!/bin/sh\necho SECRET-BODY\n', {
        mode: 0o755,
      });
      writeFileSync(join(dir, 'assets', 'logo.bin'), Buffer.from([0xff, 0x00, 0xfe]));

      const events = await startWithFolder(dir);

      const texts = events.map((event) => event.text);
      const digest = (content: Buffer | string) =>
        createHash('sha256').update(content).digest('hex');
      const line = texts.find((text) => text.startsWith('fake runner: agent folder'));
      expect(line).toMatch(
        new RegExp(
          '^fake runner: agent folder 2 files: ' +
            `assets/logo\\.bin 0[0-7]{3} sha256 ${digest(Buffer.from([0xff, 0x00, 0xfe]))}, ` +
            `scripts/check\\.sh 0[0-7]{3} sha256 ${digest('#!/bin/sh\necho SECRET-BODY\n')}$`,
        ),
      );
      expect(JSON.stringify(texts)).not.toContain('SECRET-BODY');
      expect(JSON.stringify(texts)).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs nothing it finds in the folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-fake-agent-'));
    try {
      const marker = join(dir, '..', `studio-fake-ran-${process.pid}`);
      writeFileSync(join(dir, 'run.sh'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });

      await startWithFolder(dir);

      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says nothing of a folder when there is none: a Run logs what it always did', async () => {
    const without = (await startWithFolder(null)).map((event) => event.text);

    expect(without.some((text) => text.includes('agent folder'))).toBe(false);
    const built = await start('Add a feature');
    expect(built.events.map((event) => event.text)).not.toContain('fake runner: agent folder');
  });
});

describe('the fake runner and the skills', () => {
  async function startWithSkills(
    skills: { name: string; description: string; entryFile: string }[],
  ) {
    const events: RunnerEvent[] = [];
    await drainRunStep(
      new FakeRunner({ slowMs: 10, slowLineMs: 2 }).start({
        run: run('Add a feature'),
        workspace: { ...workspace, ...(skills.length === 0 ? {} : { skills }) },
        signal: new AbortController().signal,
        processes,
      }),
      (event) => events.push(event),
    );
    return events.map((event) => ('text' in event ? event.text : ''));
  }

  it('logs the names of the placed skills, never a description or a path', async () => {
    const texts = await startWithSkills([
      {
        name: 'lint',
        description: 'Secret description',
        entryFile: '/runs/x/skills/lint/SKILL.md',
      },
      { name: 'notes', description: 'Other', entryFile: '/runs/x/skills/notes/SKILL.md' },
    ]);

    expect(texts).toContain('fake runner: skills lint, notes');
    expect(texts.join(' ')).not.toMatch(/Secret|\/runs\//);
  });

  it('logs nothing for a Run without skills', async () => {
    expect((await startWithSkills([])).some((text) => text.includes('skills'))).toBe(false);
  });
});

describe('the fake runner in a Workflow Run', () => {
  it('logs the Phase and what the Phase before reported', async () => {
    const events: RunnerEvent[] = [];
    await drainRunStep(
      new FakeRunner({ slowMs: 10, slowLineMs: 2 }).start({
        run: {
          ...run('Add a feature'),
          phase: {
            position: 1,
            itemId: 'polish',
            count: 2,
            final: true,
            previous: { itemId: 'build', agent: 'builder', summary: 'Built it.' },
          },
        },
        workspace,
        signal: new AbortController().signal,
        processes,
      }),
      (event) => events.push(event),
    );

    expect(events.map((event) => event.text)).toEqual(
      expect.arrayContaining([
        'fake runner: phase polish (2/2)',
        'fake runner: told by phase build: Built it.',
      ]),
    );
  });

  it('gives each Phase a session of its own, the first one the Run always had', () => {
    expect(fakeSessionRef('r', 0)).toBe(fakeSessionRef('r'));
    expect(fakeSessionRef('r', 1)).not.toBe(fakeSessionRef('r', 0));
    expect(fakeSessionRef('r', 2)).not.toBe(fakeSessionRef('r', 1));
  });

  it('says in its result which Phase it is of, and logs nothing of a Phase for an agent Run', async () => {
    const events: RunnerEvent[] = [];
    const result = await drainRunStep(
      new FakeRunner({ slowMs: 10, slowLineMs: 2 }).start({
        run: {
          ...run('Add a feature'),
          phase: { position: 0, itemId: 'build', count: 2, final: false },
        },
        workspace,
        signal: new AbortController().signal,
        processes,
      }),
      (event) => events.push(event),
    );

    expect(result).toMatchObject({
      outcome: 'done',
      summary: 'The fake agent finished the task. (Phase build)',
      sessionRef: fakeSessionRef(run('x').runId, 0),
    });
    const plain = await drainRunStep(
      new FakeRunner({ slowMs: 10, slowLineMs: 2 }).start({
        run: run('Add a feature'),
        workspace,
        signal: new AbortController().signal,
        processes,
      }),
      (event) => events.push(event),
    );
    expect(plain).toMatchObject({ summary: 'The fake agent finished the task.' });
  });
});

describe('the fake review Phase', () => {
  const reviewing = async (task: string) => {
    const base = run(task);
    const phase = { position: 1, itemId: 'check', count: 2, kind: 'review' as const, final: true };
    return drainRunStep(
      new FakeRunner({ slowMs: 10, slowLineMs: 2 }).start({
        run: { ...base, kind: 'next_phase', phase },
        workspace,
        signal: new AbortController().signal,
        processes,
      }),
      () => undefined,
    );
  };

  it.each([
    ['Review it', 'approved'],
    ['[fake-review:changes]', 'changes'],
    ['[fake-review:none]', 'none'],
    ['[fake-review:edits]', 'edits'],
    ['[fake-review:question]', 'question'],
    ['[fake-review:unknown]', 'approved'],
    ['[fake:fail]', 'approved'],
  ])('plays %s as the %s review', (task, scenario) => {
    expect(fakeReviewScenarioOf(task)).toBe(scenario);
  });

  it('approves by default, with a Verdict and a session of its own', async () => {
    const result = await reviewing('Add a feature');

    expect(runStepResultSchema.parse(result)).toMatchObject({
      outcome: 'done',
      verdict: 'approved',
      sessionRef: fakeSessionRef(run('x').runId, 1),
    });
    expect(result.pullRequest).toBeUndefined();
  });

  it('asks for changes with findings, one naming a file and one with markup in its text', async () => {
    const result = await reviewing('Add a feature [fake-review:changes]');

    expect(runStepResultSchema.parse(result)).toMatchObject({
      verdict: 'changes_requested',
      findings: FAKE_REVIEW_FINDINGS,
    });
  });

  it('can end without a Verdict, and can ask a question', async () => {
    expect(await reviewing('[fake-review:none]')).not.toHaveProperty('verdict');
    expect(await reviewing('[fake-review:question]')).toMatchObject({ outcome: 'needs_input' });
  });

  it('a work Phase takes no part in a review marker', async () => {
    const result = await start('Add a feature [fake-review:changes]');

    expect(result.result).not.toHaveProperty('verdict');
  });
});
