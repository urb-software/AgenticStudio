import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunDetail } from '..';
import type { RunMessageOutput, RunOutput, RunStepOutput } from '../../../platform/api';
import { anEvent, aRun, fakeRunsApi, problem } from './fake-runs-api';

// Issue #103 seam: the agent's question, the answer form and the conversation on the public
// RunDetail, with the generated client, the API wrapper and TanStack Query real, and the API
// faked at `fetch`.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

function renderRun(runId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RunDetail runId={runId} />
    </QueryClientProvider>,
  );
}

const QUESTION = {
  text: 'Which database should the store use?',
  options: ['PostgreSQL', 'SQLite'],
  recommendation: 'PostgreSQL',
};
const T0 = '2026-11-15T10:00:00.000Z';
const T1 = '2026-11-15T10:05:00.000Z';
const T2 = '2026-11-15T10:10:00.000Z';

function waitingRun(overrides: Partial<RunOutput> = {}): RunOutput {
  return aRun({
    task: 'Add a store',
    state: 'waiting_for_operator',
    startedAt: T0,
    question: QUESTION,
    messages: [
      { role: 'operator', kind: 'task', text: 'Add a store', at: T0 },
      { role: 'agent', kind: 'question', ...QUESTION, at: T1 },
    ],
    ...overrides,
  });
}

const form = () => screen.findByRole('region', { name: 'The agent needs your decision' });
const answerBox = () => screen.getByRole('textbox', { name: 'Your answer' });
const send = () => screen.getByRole('button', { name: 'Send answer' });

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.classList.remove('dark');
});

describe('Answering the agent (Issue #103)', () => {
  it('shows the question in the operator’s amber, with the options and the recommendation marked', async () => {
    const run = waitingRun();
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);

    const region = await form();
    expect(region.className).toContain('bg-run-awaiting-soft');
    expect(within(region).getByText(QUESTION.text)).toBeTruthy();
    const options = within(region).getByRole('group', { name: 'Options' });
    const recommended = within(options).getByRole('button', { name: /PostgreSQL/ });
    expect(within(recommended).getByText('Recommended')).toBeTruthy();
    expect(within(options).getByRole('button', { name: 'SQLite' })).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('sends a chosen option; the Run is queued to resume and the answer joins the conversation', async () => {
    const run = waitingRun();
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await form();

    await userEvent.click(screen.getByRole('button', { name: 'SQLite' }));
    expect(screen.getByRole('button', { name: 'SQLite' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect((answerBox() as HTMLTextAreaElement).value).toBe('SQLite');
    await userEvent.click(send());

    expect(api.calls('answer').map((call) => call.body)).toEqual([{ text: 'SQLite' }]);
    // The Run is queued to resume: the form goes, and the page says the answer was sent.
    await waitFor(() => expect(document.querySelector('[data-slot="answer-question"]')).toBeNull());
    expect(screen.getByText('Answer sent.')).toBeTruthy();
    const conversation = screen.getByRole('list', { name: 'Conversation' });
    const last = [...conversation.querySelectorAll('[data-slot="run-message"]')].at(-1);
    expect(last?.textContent).toContain('You · Answer');
    expect(last?.textContent).toContain('SQLite');
  });

  it('sends a free answer, trimmed', async () => {
    const run = waitingRun();
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await form();

    await userEvent.type(answerBox(), '  Use MySQL instead.  ');
    await userEvent.click(send());

    await waitFor(() =>
      expect(api.calls('answer').map((call) => call.body)).toEqual([
        { text: 'Use MySQL instead.' },
      ]),
    );
  });

  it('asks for an answer before sending an empty one', async () => {
    const run = waitingRun();
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await form();

    await userEvent.click(send());

    expect(screen.getByRole('alert').textContent).toContain('Enter an answer');
    expect(api.calls('answer')).toEqual([]);
  });

  it('says clearly when the Run no longer takes an answer (409)', async () => {
    const run = waitingRun();
    const api = fakeRunsApi([run]);
    api.respondNext(
      'answer',
      409,
      problem(409, 'Run not waiting for an answer', 'The run was cancelled; it takes no answer.'),
    );
    renderRun(run.id);
    await form();

    await userEvent.click(screen.getByRole('button', { name: /PostgreSQL/ }));
    await userEvent.click(send());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Run not waiting for an answer');
    expect(alert.textContent).toContain('The run was cancelled; it takes no answer.');
  });

  it('shows the API’s field error for an answer it refuses (422)', async () => {
    const run = waitingRun();
    const api = fakeRunsApi([run]);
    api.respondNext(
      'answer',
      422,
      problem(422, 'Unprocessable Entity', 'The request is invalid.', [
        { path: 'text', message: 'Use at most 10000 characters.' },
      ]),
    );
    renderRun(run.id);
    await form();

    await userEvent.type(answerBox(), 'x');
    await userEvent.click(send());

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Use at most 10000 characters.',
    );
  });

  it('takes no input while the answer is being sent', async () => {
    const run = waitingRun();
    fakeRunsApi([run]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    type Fetch = (request: Request) => Promise<Response>;
    const fetchMock = globalThis.fetch as unknown as {
      getMockImplementation(): Fetch | undefined;
      mockImplementation(next: Fetch): void;
    };
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (request: Request) => {
      if (new URL(request.url).pathname.endsWith('/answer')) await held;
      return inner(request);
    });
    renderRun(run.id);
    await form();

    await userEvent.click(screen.getByRole('button', { name: 'SQLite' }));
    await userEvent.click(send());

    await waitFor(() => expect((answerBox() as HTMLTextAreaElement).disabled).toBe(true));
    expect((screen.getByRole('button', { name: /PostgreSQL/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    release();
  });

  it('shows no answer form outside waiting', async () => {
    for (const state of ['queued', 'running', 'succeeded', 'cancelled'] as const) {
      const run = waitingRun({ state, question: undefined });
      fakeRunsApi([run]);
      const { unmount } = renderRun(run.id);
      await screen.findByRole('heading', { level: 1 });

      expect(document.querySelector('[data-slot="answer-question"]')).toBeNull();
      unmount();
    }
  });

  it('shows everything the agent wrote as plain text, never as markup', async () => {
    const markup = '<img src=x onerror=alert(1)> **bold** <script>alert(1)</script>';
    const run = waitingRun({
      question: { text: markup, options: ['<b>yes</b>'] },
      messages: [
        { role: 'operator', kind: 'task', text: 'Add a store', at: T0 },
        { role: 'agent', kind: 'question', text: markup, options: ['<b>yes</b>'], at: T1 },
      ],
    });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    const region = await form();

    expect(within(region).getByText(markup)).toBeTruthy();
    expect(within(region).getByRole('button', { name: '<b>yes</b>' })).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });
});

describe('Conversation (Issue #103)', () => {
  const messages: RunMessageOutput[] = [
    { role: 'operator', kind: 'task', text: 'Add a store', at: T0 },
    { role: 'agent', kind: 'question', ...QUESTION, at: T1 },
    { role: 'operator', kind: 'answer', text: 'PostgreSQL', at: T2 },
    { role: 'agent', kind: 'question', text: 'And the schema name?', at: T2 },
  ];

  it('lists the Task, each question and each answer in order, with the Run step between', async () => {
    const run = waitingRun({ question: { text: 'And the schema name?' }, messages });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await form();

    const conversation = screen.getByRole('list', { name: 'Conversation' });
    const items = [...conversation.querySelectorAll('[data-slot="run-message"]')].map(
      (item) => item.textContent ?? '',
    );
    expect(items).toHaveLength(4);
    expect(items[0]).toContain('You · Task');
    expect(items[0]).toContain('Add a store');
    expect(items[1]).toContain('Agent · Question');
    expect(items[1]).toContain(QUESTION.text);
    expect(items[2]).toContain('You · Answer');
    expect(items[2]).toContain('PostgreSQL');
    expect(items[3]).toContain('And the schema name?');
    // Review M2 of #127: a past question keeps its options and recommendation.
    const offered = within(conversation).getByRole('list', { name: 'Options offered' });
    expect(within(offered).getByText('Recommended')).toBeTruthy();
    expect(within(conversation).getByRole('link', { name: 'Run step 1 · log below' })).toBeTruthy();
    expect(within(conversation).getByRole('link', { name: 'Run step 2 · log below' })).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('keeps the plain Task card until the agent asks', async () => {
    const run = aRun({ state: 'running', task: 'Add a store' });
    fakeRunsApi([run]);
    renderRun(run.id);
    await screen.findByRole('heading', { level: 1 });

    expect(screen.queryByRole('list', { name: 'Conversation' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Task' })).toBeTruthy();
  });

  it('shows each question and its answer in the log after the step that asked', async () => {
    const step: RunStepOutput = {
      index: 1,
      kind: 'start',
      outcome: 'needs_input',
      summary: 'A decision is needed.',
      checks: [],
      reportedAt: T1,
    };
    const run = aRun({
      state: 'queued',
      messages: [
        { role: 'operator', kind: 'task', text: 'Add a store', at: T0 },
        { role: 'agent', kind: 'question', ...QUESTION, at: T1 },
        { role: 'operator', kind: 'answer', text: 'PostgreSQL', at: T2 },
      ],
    });
    const api = fakeRunsApi([run]);
    api.storeEvents(
      run.id,
      anEvent(1, { kind: 'step_started', text: 'Run step 1 started' }),
      anEvent(2, { kind: 'step_finished', text: 'Run step 1 finished: needs_input' }),
    );
    api.setSteps(run.id, [step]);
    renderRun(run.id);

    const log = await screen.findByRole('log', { name: 'Run log' });
    await waitFor(() => expect(log.textContent).toContain('Answer: PostgreSQL'));
    const shown = [...log.querySelectorAll('[data-slot="log-text"]')].map((t) => t.textContent);
    expect(shown).toEqual([
      'Run step 1 started',
      'Run step 1 finished: needs_input',
      'Result: needs input',
      'A decision is needed.',
      `Question: ${QUESTION.text}`,
      'Answer: PostgreSQL',
    ]);
  });
});
