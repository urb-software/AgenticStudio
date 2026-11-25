import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuns } from '..';
import { aRun, DEFAULT_RUN_AGENTS, fakeRunsApi, problem, PROJECT } from './fake-runs-api';

const SWITCHED_OFF = 'Switched off on the agent worker';
const NO_WORKER = 'No agent worker is connected';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

type RepositoryStatus = 'missing' | 'not_ready' | 'ready';

function renderRuns(repository: RepositoryStatus = 'ready') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectRuns projectId={PROJECT.id} repository={repository} />
    </QueryClientProvider>,
  );
}

const section = () => screen.getByRole('region', { name: 'Runs' });
const newRunButton = () => within(section()).getByRole('button', { name: 'New run' });
const dialog = () => screen.getByRole('dialog', { name: 'New run' });
const taskInput = () => within(dialog()).getByLabelText<HTMLTextAreaElement>('Task');
const agentSelect = () => within(dialog()).getByLabelText<HTMLSelectElement>('Agent');
const selectedAgent = () => agentSelect().value;
const optionOf = (name: string) =>
  within(agentSelect()).getByRole<HTMLOptionElement>('option', { name: new RegExp(name) });
const startButton = () => within(dialog()).getByRole('button', { name: 'Start run' });

async function rows() {
  const list = await within(section()).findByRole('list', { name: 'Runs' });
  return within(list).getAllByRole('listitem');
}

/** Opens New run and waits until this opening's provider availability has arrived. */
async function openDialog() {
  await userEvent.click(newRunButton());
  await vi.waitFor(() => expect(within(dialog()).queryByText('Checking the agents…')).toBeNull());
  return dialog();
}

afterEach(() => {
  act(() => focusManager.setFocused(undefined));
  vi.useRealTimers();
  push.mockReset();
});

describe('Runs section: list states', () => {
  it('shows a loading placeholder until the Runs arrive', async () => {
    fakeRunsApi([aRun()]);
    renderRuns();

    expect(within(section()).getByRole('status', { name: 'Loading runs' })).toBeTruthy();
    expect(await rows()).toHaveLength(1);
  });

  it('shows an empty state that points at the one primary action, New run', async () => {
    fakeRunsApi([]);
    renderRuns();

    await within(section()).findByText('Start your first run');
    expect(within(section()).getAllByRole('button')).toEqual([newRunButton()]);
    expect(newRunButton().dataset.variant).toBe('primary');
    await userEvent.click(newRunButton());

    expect(dialog()).toBeTruthy();
  });

  it('shows the failed request in mono with Retry, which recovers', async () => {
    const api = fakeRunsApi([aRun({ task: 'Add pagination' })]);
    api.respondNext('projectRuns', 503, problem(503, 'Service Unavailable'));
    renderRuns();

    const alert = await within(section()).findByRole('alert');
    expect(alert.textContent).toContain("Couldn't load the runs");
    expect(within(alert).getByText(/GET \/api\/projects\/\{id\}\/runs · 503/)).toBeTruthy();
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect((await rows())[0]!.textContent).toContain('Add pagination');
  });

  it("lists the Runs in the server's order (newest first) with state, Provider, the start of the Task and relative time", async () => {
    fakeRunsApi([
      aRun({
        task: 'Add pagination to products API\nUse cursor paging.',
        state: 'running',
        provider: 'codex',
        createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      }),
      aRun({
        task: 'Fix the login redirect',
        state: 'failed',
        createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      }),
    ]);
    const { container } = renderRuns();

    const [first, second] = await rows();
    expect(
      within(first!).getByRole('link', { name: 'Add pagination to products API' }),
    ).toBeTruthy();
    expect(within(first!).queryByText(/cursor paging/)).toBeNull();
    expect(within(first!).getByText('Running')).toBeTruthy();
    expect(within(first!).getByText('Codex')).toBeTruthy();
    expect(within(first!).getByText('3m ago')).toBeTruthy();
    expect(within(second!).getByText('Failed')).toBeTruthy();
    expect(within(second!).getByText('Claude Code')).toBeTruthy();
    expect(within(second!).getByText('2h ago')).toBeTruthy();
    const link = within(second!).getByRole('link', { name: 'Fix the login redirect' });
    expect(link.getAttribute('href')).toMatch(/^\/executions\/[0-9a-f-]+$/);
    await expect(container).toHaveNoAxeViolations();
  });

  it('updates the states without a reload while a Run is active, then stops polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = aRun({ state: 'running' });
    const api = fakeRunsApi([run]);
    renderRuns();
    await within(section()).findByText('Running');

    api.update(run.id, { state: 'succeeded' });
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    await within(section()).findByText('Succeeded');
    const settled = api.calls('projectRuns').length;

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(api.calls('projectRuns').length).toBe(settled);
  });

  it('keeps the list when a background refresh fails, with a quiet note and Retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = aRun({ state: 'running', task: 'Add pagination' });
    const api = fakeRunsApi([run]);
    renderRuns();
    await within(section()).findByText('Running');

    api.respondNext('projectRuns', 503, problem(503, 'Service Unavailable'));
    await act(() => vi.advanceTimersByTimeAsync(2_100));

    const note = await within(section()).findByText(/Couldn't refresh the runs\./);
    expect(note.closest('[role="status"]')).toBeTruthy();
    expect(within(section()).getByRole('link', { name: 'Add pagination' })).toBeTruthy();
    expect(within(section()).queryByRole('alert')).toBeNull();

    api.update(run.id, { state: 'succeeded' });
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    await within(section()).findByText('Succeeded');
    expect(within(section()).queryByText("Couldn't refresh the runs.")).toBeNull();
  });

  it('does not poll while the tab is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = aRun({ state: 'queued' });
    const api = fakeRunsApi([run]);
    renderRuns();
    await within(section()).findByText('Queued');

    act(() => focusManager.setFocused(false));
    const hidden = api.calls('projectRuns').length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.calls('projectRuns').length).toBe(hidden);
  });
});

describe('Runs section: New run availability', () => {
  it.each([
    ['missing', 'Connect a repository to start a run.'],
    ['not_ready', 'The repository is not ready yet. Runs start from its integration branch.'],
  ] as const)(
    'disables New run with an explanation when the Repository is %s',
    async (repository, explanation) => {
      fakeRunsApi([]);
      renderRuns(repository);

      const button = newRunButton();
      expect(button).toHaveProperty('disabled', true);
      const description = button.getAttribute('aria-describedby');
      expect(description && document.getElementById(description)?.textContent).toBe(explanation);
      await within(section()).findByText('Start your first run');
    },
  );
});

const DEFINITIONS_AGENT = {
  name: 'reviewer',
  description: 'Reviews code',
  provider: 'codex',
  model: 'gpt-5',
  source: 'definitions',
} as const;

const AGENTS_WITH_DEFINITIONS = {
  ...DEFAULT_RUN_AGENTS,
  agents: [...DEFAULT_RUN_AGENTS.agents, DEFINITIONS_AGENT],
};

const refusal = (type: string, title: string, detail: string) => ({
  ...problem(409, title, detail),
  type: `urn:agentic-studio:problem:${type}`,
});

describe('New run dialog', () => {
  it('opens with the Task focused, the preselected agent chosen, its Provider shown and no axe violations', async () => {
    fakeRunsApi([]);
    renderRuns();

    await openDialog();

    expect(document.activeElement).toBe(taskInput());
    expect(selectedAgent()).toBe('default-claude-code');
    expect(within(dialog()).getByText('Provider')).toBeTruthy();
    expect(within(dialog()).getByTestId('agent-provider').textContent).toBe(
      'Claude Code · model default',
    );
    // The Provider is no longer chosen separately.
    expect(within(dialog()).queryByRole('button', { name: 'Codex' })).toBeNull();
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('asks for a Task at the field and sends nothing when it is empty or blank', async () => {
    const api = fakeRunsApi([]);
    renderRuns();
    await openDialog();

    await userEvent.type(taskInput(), '   ');
    await userEvent.click(startButton());

    const error = await within(dialog()).findByText('Enter a task.');
    expect(taskInput().getAttribute('aria-invalid')).toBe('true');
    expect(taskInput().getAttribute('aria-describedby')).toContain(error.id);
    expect(api.calls('start')).toHaveLength(0);
  });

  it('hints at a Task over 20000 characters at the field, without calling the API', async () => {
    const api = fakeRunsApi([]);
    renderRuns();
    await openDialog();

    await userEvent.click(taskInput());
    await userEvent.paste('x'.repeat(20_001));
    await userEvent.click(startButton());

    expect(await within(dialog()).findByText('Use at most 20000 characters.')).toBeTruthy();
    expect(api.calls('start')).toHaveLength(0);
  });

  it('starts the Run with the preselected agent and opens its page', async () => {
    const api = fakeRunsApi([]);
    renderRuns();
    await openDialog();

    await userEvent.type(taskInput(), 'Add pagination to products API');
    await userEvent.click(startButton());

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(api.calls('start')[0]!.body).toEqual({
      task: 'Add pagination to products API',
      agent: 'default-claude-code',
    });
    expect(push).toHaveBeenCalledWith(`/executions/${api.runs()[0]!.id}`);
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers the usable agents, shows the Provider and model that follow from the chosen one, and starts with it', async () => {
    const api = fakeRunsApi([]);
    api.respondNext('runAgents', 200, AGENTS_WITH_DEFINITIONS);
    renderRuns();
    await openDialog();

    expect(within(agentSelect()).getAllByRole('option')).toHaveLength(3);
    expect(optionOf('reviewer').textContent).toContain('Codex');
    await userEvent.selectOptions(agentSelect(), 'reviewer');

    expect(within(dialog()).getByTestId('agent-provider').textContent).toBe('Codex · model gpt-5');
    expect(within(dialog()).getByText('Reviews code')).toBeTruthy();
    await userEvent.type(taskInput(), 'Review the change');
    await userEvent.click(startButton());
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(api.calls('start')[0]!.body).toEqual({ task: 'Review the change', agent: 'reviewer' });
    await expect(document.body).toHaveNoAxeViolations();
  });

  it("preselects the Project's default agent", async () => {
    const api = fakeRunsApi([]);
    api.respondNext('runAgents', 200, { ...AGENTS_WITH_DEFINITIONS, preselected: 'reviewer' });
    renderRuns();
    await openDialog();

    expect(selectedAgent()).toBe('reviewer');
    expect(within(dialog()).queryByTestId('preselected-reason')).toBeNull();
  });

  it('says why the default agent is not the one preselected', async () => {
    const api = fakeRunsApi([]);
    const reason =
      'The default agent "reviewer" is not usable: its definition has problems. The built-in Default agent is offered.';
    api.respondNext('runAgents', 200, { ...DEFAULT_RUN_AGENTS, preselectedReason: reason });
    renderRuns();
    await openDialog();

    const note = within(dialog()).getByTestId('preselected-reason');
    expect(note.textContent).toBe(reason);
    expect(agentSelect().getAttribute('aria-describedby')).toContain(note.id);
    expect(selectedAgent()).toBe('default-claude-code');
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('shows the reason as plain text, never as markup', async () => {
    const api = fakeRunsApi([]);
    api.respondNext('runAgents', 200, {
      ...DEFAULT_RUN_AGENTS,
      preselectedReason: '<a href="https://evil.example">x</a>',
    });
    renderRuns();
    await openDialog();

    expect(within(dialog()).queryByRole('link')).toBeNull();
    expect(within(dialog()).getByTestId('preselected-reason').textContent).toBe(
      '<a href="https://evil.example">x</a>',
    );
  });

  it("shows the server's field error at the Task", async () => {
    const api = fakeRunsApi([]);
    api.respondNext(
      'start',
      422,
      problem(422, 'Invalid request', 'The request body is invalid.', [
        { path: 'task', message: 'Use at most 20000 characters.' },
      ]),
    );
    renderRuns();
    await openDialog();

    await userEvent.type(taskInput(), 'Too long, says the server');
    await userEvent.click(startButton());

    expect(await within(dialog()).findByText('Use at most 20000 characters.')).toBeTruthy();
    expect(taskInput().getAttribute('aria-invalid')).toBe('true');
    expect(push).not.toHaveBeenCalled();
  });

  it('says the start failed when no answer arrives, and keeps the dialog open', async () => {
    fakeRunsApi([]);
    renderRuns();
    await openDialog();
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await userEvent.type(taskInput(), 'Add pagination');
    await userEvent.click(startButton());

    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toContain('Could not start the run. Try again.');
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the server's message when the start is rejected", async () => {
    const api = fakeRunsApi([]);
    api.respondNext(
      'start',
      409,
      problem(409, 'Repository not ready', 'The repository of this project is not ready.'),
    );
    renderRuns();
    await openDialog();

    await userEvent.type(taskInput(), 'Add pagination');
    await userEvent.click(startButton());

    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toContain('Repository not ready');
    expect(alert.textContent).toContain('The repository of this project is not ready.');
    expect(push).not.toHaveBeenCalled();
  });
});

describe('New run dialog: refused agents', () => {
  it.each([
    [
      'agent-unknown',
      'Agent unknown',
      'No agent has this name. Pick one of the agents offered for the project.',
      'This agent no longer exists.',
    ],
    [
      'agent-not-usable',
      'Agent not usable',
      'The agent cannot be used: its definition has problems. See the Agents page.',
      "This agent's definition has problems",
    ],
    [
      'provider-unavailable',
      'Provider unavailable',
      SWITCHED_OFF,
      "This agent's Provider is switched off",
    ],
  ])(
    'gives the %s refusal its own message and keeps the dialog open',
    async (type, title, detail, message) => {
      const api = fakeRunsApi([]);
      api.respondNext('start', 409, refusal(type, title, detail));
      renderRuns();
      await openDialog();

      await userEvent.type(taskInput(), 'Add pagination');
      await userEvent.click(startButton());

      const alert = await within(dialog()).findByRole('alert');
      expect(alert.textContent).toContain(title);
      expect(alert.textContent).toContain(message);
      expect(push).not.toHaveBeenCalled();
      await expect(document.body).toHaveNoAxeViolations();
    },
  );

  it('reads the agents again after an unknown or unusable refusal, so the list is current', async () => {
    const api = fakeRunsApi([]);
    api.respondNext('runAgents', 200, AGENTS_WITH_DEFINITIONS);
    api.respondNext('start', 409, refusal('agent-unknown', 'Agent unknown', 'No agent.'));
    renderRuns();
    await openDialog();
    await userEvent.selectOptions(agentSelect(), 'reviewer');

    await userEvent.type(taskInput(), 'Add pagination');
    await userEvent.click(startButton());

    await vi.waitFor(() => expect(api.calls('runAgents')).toHaveLength(2));
    await vi.waitFor(() => expect(within(agentSelect()).getAllByRole('option')).toHaveLength(2));
    expect(selectedAgent()).toBe('default-claude-code');
  });
});

describe('New run dialog: agents that cannot be read', () => {
  it('says so, offers Try again, and offers no start until the agents are known', async () => {
    const api = fakeRunsApi([]);
    api.respondNext('runAgents', 503, problem(503, 'Service Unavailable'));
    renderRuns();
    await userEvent.click(newRunButton());

    expect(await within(dialog()).findByText("Couldn't load the agents.")).toBeTruthy();
    expect(startButton()).toHaveProperty('disabled', true);
    await expect(document.body).toHaveNoAxeViolations();

    await userEvent.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    await vi.waitFor(() => expect(selectedAgent()).toBe('default-claude-code'));
    expect(api.calls('runAgents')).toHaveLength(2);
    expect(startButton()).toHaveProperty('disabled', false);
  });
});

describe('New run dialog: provider availability (Issue #101)', () => {
  it('shows an agent whose Provider is switched off as unavailable, with the reason, and never selects it', async () => {
    const api = fakeRunsApi([]);
    api.respondNext('providers', 200, [
      { id: 'claude_code', name: 'Claude Code', available: true },
      { id: 'codex', name: 'Codex', available: false, reason: SWITCHED_OFF },
    ]);
    renderRuns();
    await openDialog();

    expect(optionOf('default-codex').disabled).toBe(true);
    expect(optionOf('default-codex').textContent).toContain(SWITCHED_OFF);
    expect(optionOf('default-claude-code').disabled).toBe(false);
    expect(selectedAgent()).toBe('default-claude-code');
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('moves the preselection to the first agent with an available Provider', async () => {
    const api = fakeRunsApi([]);
    api.respondNext('providers', 200, [
      { id: 'claude_code', name: 'Claude Code', available: false, reason: SWITCHED_OFF },
      { id: 'codex', name: 'Codex', available: true },
    ]);
    renderRuns();
    await openDialog();

    await vi.waitFor(() => expect(selectedAgent()).toBe('default-codex'));
    await userEvent.type(taskInput(), 'Add pagination');
    await userEvent.click(startButton());

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(api.calls('start')[0]!.body).toEqual({ task: 'Add pagination', agent: 'default-codex' });
  });

  it('offers no start when no agent worker is connected', async () => {
    const api = fakeRunsApi([]);
    api.respondNext('providers', 200, [
      { id: 'claude_code', name: 'Claude Code', available: false, reason: NO_WORKER },
      { id: 'codex', name: 'Codex', available: false, reason: NO_WORKER },
    ]);
    renderRuns();
    await openDialog();

    expect(optionOf('default-claude-code').disabled).toBe(true);
    expect(optionOf('default-codex').disabled).toBe(true);
    expect(startButton()).toHaveProperty('disabled', true);
    await expect(document.body).toHaveNoAxeViolations();
    expect(api.calls('start')).toHaveLength(0);
  });

  it('reads the agents and the availability again each time the dialog opens', async () => {
    const api = fakeRunsApi([]);
    renderRuns();
    await openDialog();
    await vi.waitFor(() => expect(api.calls('providers')).toHaveLength(1));
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    api.respondNext('providers', 200, [
      { id: 'claude_code', name: 'Claude Code', available: true },
      { id: 'codex', name: 'Codex', available: false, reason: SWITCHED_OFF },
    ]);

    await openDialog();

    expect(optionOf('default-codex').disabled).toBe(true);
    expect(api.calls('providers')).toHaveLength(2);
    expect(api.calls('runAgents')).toHaveLength(2);
  });

  it('offers every agent when the availability cannot be read (the server decides)', async () => {
    const api = fakeRunsApi([]);
    api.respondNext('providers', 503, problem(503, 'Service Unavailable'));
    renderRuns();
    await openDialog();

    expect(
      await within(dialog()).findByText("Couldn't check which providers are available."),
    ).toBeTruthy();
    expect(optionOf('default-claude-code').disabled).toBe(false);
    expect(optionOf('default-codex').disabled).toBe(false);
  });

  it("never shows an earlier opening's answer: no start until the new one", async () => {
    const api = fakeRunsApi([]);
    api.respondNext('providers', 200, [
      { id: 'claude_code', name: 'Claude Code', available: true },
      { id: 'codex', name: 'Codex', available: false, reason: SWITCHED_OFF },
    ]);
    renderRuns();
    await openDialog();
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    let answer: (response: Response) => void = () => undefined;
    vi.mocked(fetch).mockImplementationOnce(
      () => new Promise<Response>((resolve) => (answer = resolve)),
    );

    await userEvent.click(newRunButton());

    expect(within(dialog()).getByRole('status').textContent).toBe('Checking the agents…');
    expect(within(dialog()).queryByLabelText('Agent')).toBeNull();
    expect(startButton()).toHaveProperty('disabled', true);
    await expect(document.body).toHaveNoAxeViolations();
    answer(
      new Response(JSON.stringify(DEFAULT_RUN_AGENTS), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await vi.waitFor(() => expect(startButton()).toHaveProperty('disabled', false));
    expect(optionOf('default-codex').disabled).toBe(false);
  });
});
