import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionsOverview, RunDetail } from '..';
import type { RunOutput } from '../../../platform/api';
import { formatExactTime } from '@/shared/lib/relative-time';
import { aRun, fakeRunsApi, problem } from './fake-runs-api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
const C1 = 'c'.repeat(40);
const C2 = 'd'.repeat(40);

function renderWith(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const renderRun = (runId: string) => renderWith(<RunDetail runId={runId} />);
const heading = () => screen.findByRole('heading', { level: 1 });

/** A delivered Run whose page says it can take a Follow-up. */
function delivered(overrides: Partial<RunOutput> = {}): RunOutput {
  return aRun({
    task: 'Add a health check',
    state: 'succeeded',
    startedAt: '2026-11-15T10:00:01.000Z',
    finishedAt: '2026-11-15T10:05:00.000Z',
    runBranch: 'agent/add-a-health-check-r1',
    commits: [{ id: C1, subject: 'Add GET /health', pushed: true }],
    hasUncommittedChanges: false,
    delivery: 'delivered',
    pullRequest: PULL_REQUEST,
    steps: { used: 1, usedInPart: 1 },
    followUp: { allowed: true },
    ...overrides,
  });
}

describe('Run page: Follow-up (Issue #141)', () => {
  it('sends a Follow-up: the Run is queued and the conversation shows it', async () => {
    const run = delivered();
    const api = fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    const section = screen.getByRole('region', { name: 'Send a Follow-up' });
    expect(section?.textContent).toContain('updates the same pull request');
    await expect(container).toHaveNoAxeViolations();
    await userEvent.type(within(section).getByLabelText('Follow-up'), '  Also handle HEAD.  ');
    await userEvent.click(within(section).getByRole('button', { name: 'Send Follow-up' }));

    expect(await screen.findByText('Follow-up sent.')).toBeTruthy();
    expect(api.calls('followUp')[0]?.body).toEqual({ text: 'Also handle HEAD.' });
    // The Run is no longer finished: no form, no "Run again".
    expect(screen.queryByRole('region', { name: 'Send a Follow-up' })).toBeNull();
    const conversation = screen.getByRole('list', { name: 'Conversation' });
    expect(conversation?.textContent).toContain('You · Follow-up 1');
    expect(conversation?.textContent).toContain('Follow-up 1 begins');
    expect(conversation?.textContent).toContain('Also handle HEAD.');
    // The pull request stays; the Follow-up updates it when it is done.
    expect(
      screen.getByText('The Follow-up updates the draft pull request when it is done.'),
    ).toBeTruthy();
  });

  it('checks the text before sending: empty, or longer than 10 000 characters', async () => {
    const run = delivered();
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();
    const section = screen.getByRole('region', { name: 'Send a Follow-up' });

    await userEvent.click(within(section).getByRole('button', { name: 'Send Follow-up' }));
    expect(within(section).getByRole('alert')?.textContent).toContain('Enter a Follow-up.');

    const field = within(section).getByLabelText('Follow-up');
    await userEvent.click(field);
    await userEvent.paste('a'.repeat(10_001));
    await userEvent.click(within(section).getByRole('button', { name: 'Send Follow-up' }));
    expect(within(section).getByRole('alert')?.textContent).toContain(
      'Use at most 10000 characters.',
    );
    expect(api.calls('followUp')).toHaveLength(0);
  });

  it("shows the server's field error (422) on the field and a refusal (409) as a banner", async () => {
    const run = delivered();
    const api = fakeRunsApi([run]);
    api.respondNext(
      'followUp',
      422,
      problem(422, 'Unprocessable Entity', 'The request is invalid.', [
        { path: 'text', message: 'Use at most 10000 characters.' },
      ]),
    );
    api.respondNext(
      'followUp',
      409,
      problem(409, 'Follow-up not possible', 'A Follow-up is already queued for this run.'),
    );
    renderRun(run.id);
    await heading();
    const section = screen.getByRole('region', { name: 'Send a Follow-up' });
    await userEvent.type(within(section).getByLabelText('Follow-up'), 'Go on.');

    await userEvent.click(within(section).getByRole('button', { name: 'Send Follow-up' }));
    expect(await within(section).findByText('Use at most 10000 characters.')).toBeTruthy();

    await userEvent.click(within(section).getByRole('button', { name: 'Send Follow-up' }));
    expect(await screen.findByText('Follow-up not possible')).toBeTruthy();
    expect(screen.getByText('A Follow-up is already queued for this run.')).toBeTruthy();
  });

  it('takes no input while the Follow-up is being sent', async () => {
    const run = delivered();
    const api = fakeRunsApi([run]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const fetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (request: Request) => {
      if (new URL(request.url).pathname.endsWith('/follow-up')) await held;
      return fetch(request);
    });
    renderRun(run.id);
    await heading();
    const section = screen.getByRole('region', { name: 'Send a Follow-up' });
    await userEvent.type(within(section).getByLabelText('Follow-up'), 'Go on.');
    await userEvent.click(within(section).getByRole('button', { name: 'Send Follow-up' }));

    expect((within(section).getByLabelText('Follow-up') as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect(
      (within(section).getByRole('button', { name: /Send Follow-up/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    release();
    expect(await screen.findByText('Follow-up sent.')).toBeTruthy();
    expect(api.calls('followUp')).toHaveLength(1);
  });

  it.each([
    [
      'working_copy_removed',
      'The working copy was removed on the agent worker, so the run can no longer be continued.',
      true,
    ],
    ['no_session', 'The run has no agent session to continue.', true],
    ['step_total_reached', 'The run has used all 50 run steps it may take in total.', true],
    ['provider_unavailable', "The run's provider is unavailable on the agent worker.", false],
    ['worker_unavailable', 'is not connected', false],
    ['follow_up_queued', 'A Follow-up is already queued for this run.', false],
  ] as const)('says why a Follow-up is not possible: %s', async (reason, text, runAgain) => {
    const run = delivered({ state: 'failed', followUp: { allowed: false, reason } });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    const section = screen.getByRole('region', { name: 'Follow-up not possible' });
    expect(section?.textContent).toContain(text);
    expect(section.textContent?.includes('Run again')).toBe(runAgain);
    expect(screen.queryByLabelText('Follow-up')).toBeNull();
    expect(screen.getByRole('button', { name: 'Run again' })).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  // Until when the Run stays open to Follow-ups.
  it('says until when the Run is open to Follow-ups', async () => {
    const openUntil = '2026-12-14T09:30:00.000Z';
    const run = delivered({ followUp: { allowed: true, openUntil } });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    const section = screen.getByRole('region', { name: 'Send a Follow-up' });
    expect(section.textContent).toContain(
      `Open to Follow-ups until ${formatExactTime(new Date(openUntil))}.`,
    );
    expect(section.querySelector('time')?.getAttribute('datetime')).toBe(openUntil);
    await expect(container).toHaveNoAxeViolations();
  });

  it('says removal is pending instead of a date, for a Run whose date passed or the limit removes', async () => {
    const run = delivered({ followUp: { allowed: true, removalPending: true } });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    const section = screen.getByRole('region', { name: 'Send a Follow-up' });
    expect(section.textContent).toContain('Removal pending');
    expect(section.textContent).toContain('can no longer be continued');
    expect(section.textContent).not.toContain('Open to Follow-ups until');
    expect(section.querySelector('time')).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('also says it while the Run only waits for its worker, and never once it is not open', async () => {
    const openUntil = '2026-12-14T09:30:00.000Z';
    const waiting = delivered({
      followUp: { allowed: false, reason: 'worker_unavailable', openUntil },
    });
    fakeRunsApi([waiting]);
    renderRun(waiting.id);
    await heading();
    expect(screen.getByRole('region', { name: 'Follow-up not possible' }).textContent).toContain(
      'Open to Follow-ups until',
    );
    cleanup();

    const removed = delivered({ followUp: { allowed: false, reason: 'working_copy_removed' } });
    fakeRunsApi([removed]);
    renderRun(removed.id);
    await heading();
    const section = screen.getByRole('region', { name: 'Follow-up not possible' });
    expect(section.textContent).not.toContain('Open to Follow-ups until');
    expect(section.textContent).toContain('can no longer be continued');
    expect(section.textContent).toContain('conversation, log, changes and pull request link stay');
  });

  it('offers no Follow-up while the page does not know whether it is possible', async () => {
    const run = delivered({ followUp: undefined });
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    expect(screen.queryByRole('region', { name: 'Send a Follow-up' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Follow-up not possible' })).toBeNull();
  });

  it('says a queued Follow-up waits for a free place, like any queued Run', async () => {
    const run = delivered({
      state: 'queued',
      finishedAt: undefined,
      delivery: undefined,
      followUps: 1,
      followUp: { allowed: false, reason: 'follow_up_queued' },
      messages: [
        {
          role: 'operator',
          kind: 'task',
          text: 'Add a health check',
          at: '2026-11-15T10:00:00.000Z',
        },
        { role: 'operator', kind: 'follow_up', text: 'Go on.', at: '2026-11-15T11:00:00.000Z' },
      ],
    });
    const busy = aRun({ state: 'running' });
    fakeRunsApi([busy, run]);
    renderRun(run.id);
    await heading();

    expect(await screen.findByText(/Another run is active on this project/)).toBeTruthy();
    expect(screen.getByText('Follow-up sent.')).toBeTruthy();
  });
});

describe('Run page: a Run with Follow-ups (Issue #141)', () => {
  const messages: RunOutput['messages'] = [
    { role: 'operator', kind: 'task', text: 'Add a health check', at: '2026-11-15T10:00:00.000Z' },
    {
      role: 'studio',
      kind: 'part_end',
      text: '',
      end: { state: 'succeeded', delivery: 'delivered' },
      at: '2026-11-15T11:00:00.000Z',
    },
    { role: 'operator', kind: 'follow_up', text: 'Handle HEAD.', at: '2026-11-15T11:00:00.000Z' },
    {
      role: 'agent',
      kind: 'question',
      text: 'Which status code?',
      at: '2026-11-15T11:01:00.000Z',
    },
    { role: 'operator', kind: 'answer', text: '204', at: '2026-11-15T11:02:00.000Z' },
    {
      role: 'studio',
      kind: 'part_end',
      text: 'The tests did not compile.',
      end: { state: 'failed', failureCode: 'agent_failed' },
      at: '2026-11-15T12:00:00.000Z',
    },
    { role: 'operator', kind: 'follow_up', text: 'And OPTIONS.', at: '2026-11-15T12:00:00.000Z' },
  ];
  const step = (index: number, outcome: 'done' | 'needs_input', summary: string, at: string) => ({
    index,
    kind: index === 1 ? ('start' as const) : ('resume' as const),
    outcome,
    summary,
    checks: [],
    reportedAt: at,
  });

  it('keeps every result in the conversation, each part after its Follow-up, with its step', async () => {
    const run = delivered({
      state: 'failed',
      failure: { code: 'agent_failed', detail: 'It broke.' },
      delivery: undefined,
      followUps: 2,
      steps: { used: 3, usedInPart: 0 },
      followUp: { allowed: true },
      messages,
    });
    const api = fakeRunsApi([run]);
    api.setSteps(run.id, [
      step(1, 'done', 'Added GET /health.', '2026-11-15T10:04:00.000Z'),
      step(2, 'needs_input', 'A decision is needed.', '2026-11-15T11:01:00.000Z'),
      step(3, 'done', 'HEAD answers 204.', '2026-11-15T11:05:00.000Z'),
    ]);
    const { container } = renderRun(run.id);
    await heading();

    const conversation = screen.getByRole('list', { name: 'Conversation' });
    await within(conversation).findByText('HEAD answers 204.');
    const turns = within(conversation)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    const order = [
      'You · Task',
      'Run step 1 · log below',
      'Agent · Result',
      'The first part ended: Succeeded · the draft pull request was delivered',
      'Follow-up 1 begins',
      'You · Follow-up 1',
      'Run step 2 · log below',
      'Agent · Question',
      'You · Answer',
      'Run step 3 · log below',
      'Agent · Result',
      'Follow-up 1 ended: Failed',
      'Follow-up 2 begins',
      'You · Follow-up 2',
    ];
    let at = 0;
    for (const expected of order) {
      const found = turns.findIndex((turn, i) => i >= at && turn.includes(expected));
      expect(found, expected).toBeGreaterThanOrEqual(0);
      at = found + 1;
    }
    expect(within(conversation).getByText('Added GET /health.')).toBeTruthy();
    // The earlier failure's reason stays visible, as plain text.
    expect(within(conversation).getByText('The tests did not compile.')).toBeTruthy();
    // The kept pull request: this Follow-up pushed nothing.
    expect(screen.getByText('This Follow-up pushed nothing.')).toBeTruthy();
    expect(screen.queryByText('Nothing was pushed.')).toBeNull();
    expect(screen.getByRole('link', { name: /Pull request #7/ })).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows the step totals, the limits and which commits are pushed', async () => {
    const run = delivered({
      followUps: 1,
      steps: { used: 3, usedInPart: 2 },
      commits: [
        { id: C1, subject: 'Add GET /health', pushed: true },
        { id: C2, subject: 'Handle <b>HEAD</b>', pushed: false },
      ],
    });
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    expect(screen.getByText('3 of 50 in total · 2 of 10 in this Follow-up')).toBeTruthy();
    expect(
      screen.getByText(/at most 10 run steps per part \(first part or Follow-up\)/),
    ).toBeTruthy();
    expect(screen.getByText(/50 run steps in total/)).toBeTruthy();
    const commits = within(screen.getByRole('list', { name: 'Commits' })).getAllByRole('listitem');
    expect(commits[0]?.textContent).toContain('cccccccAdd GET /healthPushed');
    // The agent's subject is plain text, never markup.
    expect(commits[1]?.textContent).toContain('Handle <b>HEAD</b>Only in the working copy');
    expect(commits[1]?.querySelector('b')).toBeNull();
  });

  it('says the pushed state is unknown when the pushed commit is not listed (review S5)', async () => {
    const run = delivered({ commits: [{ id: C1, subject: 'Add GET /health' }] });
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    const commits = within(screen.getByRole('list', { name: 'Commits' })).getAllByRole('listitem');
    expect(commits[0]?.textContent).toContain('Pushed state unknown');
  });

  it('counts the run steps of the run when it has had no Follow-up', async () => {
    const run = delivered();
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    expect(screen.getByText('1 of 50 in total · 1 of 10 in this run')).toBeTruthy();
  });
});

describe('Runs lists: Follow-ups (Issue #141)', () => {
  it('marks a Run that has had Follow-ups', async () => {
    fakeRunsApi([
      aRun({ task: 'Two follow-ups', state: 'queued', followUps: 2 }),
      aRun({ task: 'One follow-up', state: 'succeeded', followUps: 1 }),
      aRun({ task: 'None', state: 'succeeded' }),
    ]);
    renderWith(<ExecutionsOverview />);

    const rows = within(await screen.findByRole('list', { name: 'Runs' })).getAllByRole('listitem');
    expect(rows[0]?.textContent).toContain('2 Follow-ups');
    expect(rows[1]?.textContent).toContain('1 Follow-up');
    expect(rows[2]?.textContent).not.toContain('Follow-up');
  });
});
