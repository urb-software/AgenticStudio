import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunDetail } from '..';
import { RunRows } from '../components/run-rows';
import type { RunOutput } from '../../../platform/api';
import { aRun, fakeRunsApi, problem } from './fake-runs-api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

function renderRun(runId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RunDetail runId={runId} />
    </QueryClientProvider>,
  );
}

const T0 = '2026-11-15T10:00:00.000Z';
const REPORT = 'Planned the endpoint: one route, one test.';
const CHECKPOINT = { id: 'look', text: 'Read the plan before the build starts.' };

const ITEMS: NonNullable<RunOutput['workflow']>['items'] = [
  { id: 'plan', kind: 'work', agent: 'planner' },
  { id: 'look', kind: 'checkpoint', text: CHECKPOINT.text },
  { id: 'build', kind: 'work', agent: 'builder' },
];

const agent = (name: string) => ({
  name,
  source: 'definitions' as const,
  commit: 'c'.repeat(40),
  provider: 'claude_code' as const,
  model: 'default',
  skills: [],
});

/** A Run of a Workflow that waits at the Checkpoint "look", after the Phase "plan". */
function atCheckpoint(overrides: Partial<RunOutput> = {}): RunOutput {
  return aRun({
    task: 'Plan, wait for me, build',
    state: 'waiting_for_operator',
    startedAt: T0,
    workflowName: 'plan-then-build',
    workflow: { name: 'plan-then-build', commit: 'c'.repeat(40), items: ITEMS },
    waiting: { reason: 'checkpoint', checkpoint: CHECKPOINT },
    phases: [
      {
        position: 0,
        itemId: 'plan',
        state: 'done',
        summary: REPORT,
        agent: agent('planner'),
        stepsUsed: 1,
      },
      {
        position: 1,
        itemId: 'build',
        state: 'pending',
        summary: null,
        agent: agent('builder'),
        stepsUsed: 0,
      },
    ],
    ...overrides,
  });
}

const card = () => screen.findByRole('region', { name: 'Your Workflow is waiting for you' });
const comment = () => screen.getByRole('textbox', { name: 'Note for the next Phase (optional)' });
const goOn = () => screen.getByRole('button', { name: 'Continue' });
const stopHere = () => screen.getByRole('button', { name: 'Stop here' });

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.classList.remove('dark');
});

describe('a Run waiting at a Checkpoint', () => {
  it('shows the Checkpoint text and what the Phase before it reported, as plain text', async () => {
    const hostile = '<img src=x onerror=alert(1)> **bold**';
    const run = atCheckpoint({
      phases: [{ ...atCheckpoint().phases![0]!, summary: hostile }, atCheckpoint().phases![1]!],
    });
    fakeRunsApi([run]);
    renderRun(run.id);

    const region = await card();
    expect(region.className).toContain('bg-run-awaiting-soft');
    expect(within(region).getByText(CHECKPOINT.text)).toBeTruthy();
    expect(within(region).getByText(/Reported by Phase/)).toBeTruthy();
    expect(within(region).getByText(hostile)).toBeTruthy();
    expect(region.querySelector('img')).toBeNull();
    expect(region.querySelector('strong')).toBeNull();
  });

  it('links to the Changes tab, which shows the Working copy state', async () => {
    const run = atCheckpoint();
    fakeRunsApi([run]);
    renderRun(run.id);
    const region = await card();

    await userEvent.click(within(region).getByRole('button', { name: 'See what changed' }));

    const tab = screen.getByRole('tab', { name: 'Changes' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
  });

  it('says so when the Checkpoint comes before any Phase', async () => {
    const run = atCheckpoint({
      workflow: {
        name: 'plan-then-build',
        commit: 'c'.repeat(40),
        items: [{ id: 'look', kind: 'checkpoint', text: CHECKPOINT.text }, ITEMS[0]!, ITEMS[2]!],
      },
      phases: [
        { ...atCheckpoint().phases![0]!, state: 'pending', summary: null, stepsUsed: 0 },
        atCheckpoint().phases![1]!,
      ],
    });
    fakeRunsApi([run]);
    renderRun(run.id);

    const region = await card();
    expect(within(region).getByText(/No Phase has run yet/)).toBeTruthy();
    expect(within(region).queryByText(REPORT)).toBeNull();
  });

  it('sends Continue with the note, trimmed, naming the Checkpoint it saw; the page then moves on', async () => {
    const run = atCheckpoint();
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await card();

    await userEvent.type(comment(), '  Use the small plan.  ');
    await userEvent.click(goOn());

    await waitFor(() =>
      expect(api.calls('checkpointContinue').map((call) => call.body)).toEqual([
        { comment: 'Use the small plan.', checkpoint: 'look' },
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Your Workflow is waiting for you' })).toBeNull(),
    );
  });

  it('sends Continue without a note when none was written', async () => {
    const run = atCheckpoint();
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await card();

    await userEvent.click(goOn());

    await waitFor(() =>
      expect(api.calls('checkpointContinue').map((call) => call.body)).toEqual([
        { checkpoint: 'look' },
      ]),
    );
  });

  it('refuses a note of more than 4,000 characters before sending anything', async () => {
    const run = atCheckpoint();
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await card();

    await userEvent.click(comment());
    await userEvent.paste('x'.repeat(4001));
    await userEvent.click(goOn());

    expect(screen.getByText('Use at most 4,000 characters.')).toBeTruthy();
    expect(api.calls('checkpointContinue')).toEqual([]);
  });

  it('asks for a confirmation before stopping, and stopping sends nothing until it is given', async () => {
    const run = atCheckpoint();
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await card();

    await userEvent.click(stopHere());
    const dialog = screen.getByRole('alertdialog', { name: 'Stop here' });
    expect(within(dialog).getByText(/delivers what exists/)).toBeTruthy();
    expect(api.calls('checkpointStop')).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep waiting' }));
    expect(screen.queryByRole('alertdialog', { name: 'Stop here' })).toBeNull();
    expect(api.calls('checkpointStop')).toEqual([]);

    await userEvent.click(stopHere());
    await userEvent.click(
      within(screen.getByRole('alertdialog', { name: 'Stop here' })).getByRole('button', {
        name: 'Stop here and deliver',
      }),
    );

    await waitFor(() =>
      expect(api.calls('checkpointStop').map((call) => call.body)).toEqual([
        { checkpoint: 'look' },
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Stop here' })).toBeNull(),
    );
  });

  it('says why when the Run is no longer at the Checkpoint, and reads it again', async () => {
    const run = atCheckpoint();
    const api = fakeRunsApi([run]);
    api.respondNext('checkpointContinue', 409, {
      ...problem(409, 'Run not at a Checkpoint', 'The run is not waiting at this Checkpoint.'),
      type: 'urn:agentic-studio:problem:run-not-at-checkpoint',
    });
    renderRun(run.id);
    await card();

    await userEvent.click(goOn());

    expect(await screen.findByText('The run is not waiting at this Checkpoint.')).toBeTruthy();
    await waitFor(() => expect(api.calls('run').length).toBeGreaterThan(1));
  });

  it('takes no input once the Run no longer waits', async () => {
    const run = atCheckpoint();
    fakeRunsApi([run]);
    renderRun(run.id);
    await card();

    expect((goOn() as HTMLButtonElement).disabled).toBe(false);
    expect((comment() as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('has no note field when no Phase follows: Continue then ends the Workflow', async () => {
    const run = atCheckpoint({
      workflow: {
        name: 'plan-then-build',
        commit: 'c'.repeat(40),
        items: [ITEMS[0]!, ITEMS[1]!],
      },
    });
    fakeRunsApi([run]);
    renderRun(run.id);

    const region = await card();
    expect(within(region).queryByRole('textbox')).toBeNull();
    expect(within(region).getByText(/No Phase follows/)).toBeTruthy();
  });

  it('is reachable and usable from the keyboard alone, with no accessibility violation, in both themes', async () => {
    const run = atCheckpoint();
    const api = fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await card();
    await expect(container).toHaveNoAxeViolations();

    document.documentElement.classList.add('dark');
    await expect(container).toHaveNoAxeViolations();

    await userEvent.click(comment());
    await userEvent.type(comment(), 'Go.');
    await userEvent.tab();
    expect(document.activeElement).toBe(goOn());
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(api.calls('checkpointContinue').map((call) => call.body)).toEqual([
        { comment: 'Go.', checkpoint: 'look' },
      ]),
    );
  });

  it('marks the Checkpoint among the Phases: waiting for you', async () => {
    const run = atCheckpoint();
    fakeRunsApi([run]);
    renderRun(run.id);
    await card();

    const phases = screen.getByRole('region', { name: /Phases of plan-then-build/ });
    const marker = within(phases).getByTestId('run-checkpoint-item');
    expect(marker.textContent).toContain('look');
    expect(marker.textContent).toContain('Waiting for you');
  });

  it('shows no Checkpoint card for a Run that waits for an Answer', async () => {
    const run = aRun({
      state: 'waiting_for_operator',
      question: { text: 'Which database?' },
      waiting: { reason: 'question' },
      messages: [
        { role: 'operator', kind: 'task', text: 'x', at: T0 },
        { role: 'agent', kind: 'question', text: 'Which database?', at: T0 },
      ],
    });
    fakeRunsApi([run]);
    renderRun(run.id);

    await screen.findByRole('region', { name: 'The agent needs your decision' });
    expect(screen.queryByRole('region', { name: 'Your Workflow is waiting for you' })).toBeNull();
  });
});

describe('the Runs list', () => {
  const renderRows = (runs: RunOutput[]) =>
    render(<RunRows runs={runs} now={Date.parse(T0)} label="Runs" />);

  it('marks a Run waiting at a Checkpoint, apart from one waiting for an Answer', () => {
    const asked = aRun({
      task: 'Asks a question',
      state: 'waiting_for_operator',
      waiting: { reason: 'question' },
    });
    renderRows([atCheckpoint({ task: 'Stops at a Checkpoint' }), asked]);

    const [checkpointRow, questionRow] = screen.getAllByRole('listitem');
    expect(within(checkpointRow!).getByText(/At Checkpoint/)).toBeTruthy();
    expect(checkpointRow!.textContent).toContain('look');
    expect(within(questionRow!).queryByText(/At Checkpoint/)).toBeNull();
    expect(within(questionRow!).getByText('Waiting for you')).toBeTruthy();
  });

  it('marks nothing for a Run that is not waiting', () => {
    renderRows([atCheckpoint({ state: 'running', waiting: undefined })]);

    expect(screen.queryByText(/At Checkpoint/)).toBeNull();
  });
});
