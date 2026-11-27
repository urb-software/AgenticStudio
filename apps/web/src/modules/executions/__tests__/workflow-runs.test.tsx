import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuns, RunDetail } from '..';
import { summary } from '../../workflows/__tests__/fake-workflows-api';
import { aRun, fakeRunsApi, problem, PROJECT } from './fake-runs-api';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const dialog = () => screen.getByRole('dialog', { name: 'New run' });
const chooser = () => within(dialog()).getByLabelText<HTMLSelectElement>('Agent or Workflow');

async function openDialog() {
  render(
    <QueryClientProvider client={client()}>
      <ProjectRuns projectId={PROJECT.id} repository="ready" />
    </QueryClientProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: 'New run' }));
  await vi.waitFor(() => expect(within(dialog()).queryByText('Checking the agents…')).toBeNull());
}

afterEach(() => push.mockReset());

describe('New run: agents and Workflows in one chooser', () => {
  it('groups the agents and the usable Workflows, and leaves out a Workflow that is not usable', async () => {
    const api = fakeRunsApi([]);
    api.setWorkflows([
      summary('ship'),
      summary('broken', { usable: false, notUsableReason: 'A Provider is off.' }),
    ]);
    await openDialog();

    const groups = within(chooser()).getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('label'))).toEqual(['Agents', 'Workflows']);
    expect(
      within(groups[1]!)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['ship']);
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('offers no Workflows group when there is none', async () => {
    fakeRunsApi([]);
    await openDialog();

    expect(within(chooser()).getAllByRole('group')).toHaveLength(1);
  });

  it('starts with the chosen Workflow, naming it in place of an agent', async () => {
    const api = fakeRunsApi([]);
    api.setWorkflows([summary('ship', { description: 'Builds and polishes' })]);
    await openDialog();

    await userEvent.selectOptions(chooser(), 'workflow:ship');
    expect(within(dialog()).getByTestId('workflow-facts').textContent).toContain('ship');
    expect(within(dialog()).getByText('Builds and polishes')).toBeTruthy();
    await userEvent.type(within(dialog()).getByLabelText('Task'), 'Add a health check');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Start run' }));

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(api.calls('start')[0]!.body).toEqual({ task: 'Add a health check', workflow: 'ship' });
  });

  it('can be driven by the keyboard alone', async () => {
    const api = fakeRunsApi([]);
    api.setWorkflows([summary('ship')]);
    await openDialog();

    await userEvent.type(within(dialog()).getByLabelText('Task'), 'Do it');
    await userEvent.tab();
    expect(document.activeElement).toBe(chooser());
    await userEvent.keyboard('{Enter}');
    await userEvent.selectOptions(chooser(), 'workflow:ship');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Start run' }));

    await vi.waitFor(() => expect(api.calls('start')).toHaveLength(1));
  });

  it('says what a refused Workflow was refused for, and reads the list again', async () => {
    const api = fakeRunsApi([]);
    api.setWorkflows([summary('ship')]);
    await openDialog();
    api.respondNext('start', 409, {
      ...problem(
        409,
        'Workflow not usable',
        'The Workflow cannot be used: a Phase names a gone agent.',
      ),
      type: 'urn:agentic-studio:problem:workflow-not-usable',
    });

    await userEvent.selectOptions(chooser(), 'workflow:ship');
    await userEvent.type(within(dialog()).getByLabelText('Task'), 'Do it');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Start run' }));

    expect(await within(dialog()).findByText(/This Workflow cannot start a run now/)).toBeTruthy();
    expect(within(dialog()).getByText(/a Phase names a gone agent/)).toBeTruthy();
    await vi.waitFor(() => expect(api.calls('workflows').length).toBeGreaterThan(1));
  });
});

describe('Run page: the Phases of a Workflow Run', () => {
  const phase = (
    position: number,
    state: 'pending' | 'running' | 'done' | 'failed',
    more: { summary?: string; stepsUsed?: number } = {},
  ) => ({
    position,
    itemId: ['build', 'polish'][position]!,
    state,
    summary: null as string | null,
    agent: {
      name: ['builder', 'polisher'][position]!,
      source: 'definitions' as const,
      commit: 'c'.repeat(40),
      provider: position === 0 ? ('codex' as const) : ('claude_code' as const),
      model: 'default',
      skills: [] as string[],
    },
    stepsUsed: 0,
    ...more,
  });

  const workflowRun = () =>
    aRun({
      state: 'running',
      workflowName: 'ship',
      workflow: {
        name: 'ship',
        commit: 'c'.repeat(40),
        items: [
          { id: 'build', kind: 'work', agent: 'builder' },
          { id: 'polish', kind: 'work', agent: 'polisher' },
        ],
      },
      phases: [
        phase(0, 'done', { summary: 'Built the endpoint.', stepsUsed: 1 }),
        phase(1, 'running'),
      ],
    });

  const renderRun = (runId: string) =>
    render(
      <QueryClientProvider client={client()}>
        <RunDetail runId={runId} />
      </QueryClientProvider>,
    );

  it('shows each Phase with its agent and result, and marks the one that is running', async () => {
    const run = workflowRun();
    fakeRunsApi([run]);
    renderRun(run.id);

    const card = await screen.findByRole('region', { name: 'Phases of ship' });
    const items = within(card).getAllByTestId('run-phase');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('builder');
    expect(items[0]!.textContent).toContain('Done');
    expect(within(items[0]!).getByTestId('run-phase-summary').textContent).toBe(
      'Built the endpoint.',
    );
    expect(items[1]!.textContent).toContain('Claude Code');
    expect(items[1]!.getAttribute('aria-current')).toBe('step');
    expect(items[0]!.getAttribute('aria-current')).toBeNull();
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('shows no Phases for a Run started with an agent', async () => {
    const run = aRun({ state: 'running' });
    fakeRunsApi([run]);
    renderRun(run.id);

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByTestId('run-phase')).toBeNull();
  });

  it('opens Run again with the Workflow chosen', async () => {
    const run = { ...workflowRun(), state: 'succeeded' as const };
    const api = fakeRunsApi([run]);
    api.setWorkflows([summary('ship')]);
    renderRun(run.id);

    await userEvent.click(await screen.findByRole('button', { name: 'Run again' }));

    await vi.waitFor(() => expect(chooser().value).toBe('workflow:ship'));
  });
});

describe('Runs list: the Workflow of a Run', () => {
  it('names the Workflow on a row, and nothing on a Run with an agent', async () => {
    fakeRunsApi([aRun({ task: 'One', workflowName: 'ship' }), aRun({ task: 'Two' })]);
    render(
      <QueryClientProvider client={client()}>
        <ProjectRuns projectId={PROJECT.id} repository="ready" />
      </QueryClientProvider>,
    );

    const list = await screen.findByRole('list', { name: 'Runs' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first!.textContent).toContain('Workflow ship');
    expect(second!.textContent).not.toContain('Workflow');
  });
});
