import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuns } from '..';
import { aRun, fakeRunsApi, problem, PROJECT } from './fake-runs-api';

const SWITCHED_OFF = 'Switched off on the agent worker';
const NO_WORKER = 'No agent worker is connected';

// Runs section seam (Story #97): the public ProjectRuns of the executions module with the New
// run dialog, the generated client, the API wrapper and TanStack Query real, and the API faked
// at `fetch`.

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
const providerButton = (name: string) => within(dialog()).getByRole('button', { name });
const startButton = () => within(dialog()).getByRole('button', { name: 'Start run' });

async function rows() {
  const list = await within(section()).findByRole('list', { name: 'Runs' });
  return within(list).getAllByRole('listitem');
}

/** Opens New run and waits until this opening's provider availability has arrived. */
async function openDialog() {
  await userEvent.click(newRunButton());
  await vi.waitFor(() =>
    expect(within(dialog()).queryByText('Checking which providers are available…')).toBeNull(),
  );
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

describe('New run dialog', () => {
  it('opens with the Task focused, Claude Code preselected and no axe violations', async () => {
    fakeRunsApi([]);
    renderRuns();

    await openDialog();

    expect(document.activeElement).toBe(taskInput());
    expect(providerButton('Claude Code').getAttribute('aria-pressed')).toBe('true');
    expect(providerButton('Codex').getAttribute('aria-pressed')).toBe('false');
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

  it('starts the Run with the chosen Provider and opens its page', async () => {
    const api = fakeRunsApi([]);
    renderRuns();
    await openDialog();

    await userEvent.type(taskInput(), 'Add pagination to products API');
    await userEvent.click(providerButton('Codex'));
    await userEvent.click(startButton());

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(api.calls('start')[0]!.body).toEqual({
      task: 'Add pagination to products API',
      provider: 'codex',
    });
    expect(push).toHaveBeenCalledWith(`/executions/${api.runs()[0]!.id}`);
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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

describe('New run dialog: provider availability (Issue #101)', () => {
  it('shows a provider switched off on the worker as unavailable with the reason', async () => {
    const api = fakeRunsApi([]);
    api.respondNext('providers', 200, [
      { id: 'claude_code', name: 'Claude Code', available: true },
      { id: 'codex', name: 'Codex', available: false, reason: SWITCHED_OFF },
    ]);
    renderRuns();
    await openDialog();

    const reason = await within(dialog()).findByText(`Codex: ${SWITCHED_OFF}`);
    expect(providerButton('Codex').getAttribute('aria-disabled')).toBe('true');
    expect(providerButton('Codex').getAttribute('aria-describedby')).toBe(reason.id);
    expect(providerButton('Claude Code').getAttribute('aria-pressed')).toBe('true');
    expect(providerButton('Claude Code').getAttribute('aria-disabled')).toBeNull();
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('preselects the first available provider when Claude Code is switched off', async () => {
    const api = fakeRunsApi([]);
    api.respondNext('providers', 200, [
      { id: 'claude_code', name: 'Claude Code', available: false, reason: SWITCHED_OFF },
      { id: 'codex', name: 'Codex', available: true },
    ]);
    renderRuns();
    await openDialog();

    await vi.waitFor(() =>
      expect(providerButton('Codex').getAttribute('aria-pressed')).toBe('true'),
    );
    expect(providerButton('Claude Code').getAttribute('aria-disabled')).toBe('true');
    await userEvent.type(taskInput(), 'Add pagination');
    await userEvent.click(startButton());

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(api.calls('start')[0]!.body).toEqual({ task: 'Add pagination', provider: 'codex' });
  });

  it('offers no provider and no start when no agent worker is connected', async () => {
    const api = fakeRunsApi([]);
    api.respondNext('providers', 200, [
      { id: 'claude_code', name: 'Claude Code', available: false, reason: NO_WORKER },
      { id: 'codex', name: 'Codex', available: false, reason: NO_WORKER },
    ]);
    renderRuns();
    await openDialog();

    expect(await within(dialog()).findByText(`Claude Code: ${NO_WORKER}`)).toBeTruthy();
    expect(within(dialog()).getByText(`Codex: ${NO_WORKER}`)).toBeTruthy();
    expect(providerButton('Claude Code').getAttribute('aria-disabled')).toBe('true');
    expect(providerButton('Codex').getAttribute('aria-disabled')).toBe('true');
    expect(startButton()).toHaveProperty('disabled', true);
    await expect(document.body).toHaveNoAxeViolations();
    expect(api.calls('start')).toHaveLength(0);
  });

  it('reads the availability again each time the dialog opens', async () => {
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

    expect(await within(dialog()).findByText(`Codex: ${SWITCHED_OFF}`)).toBeTruthy();
    expect(api.calls('providers')).toHaveLength(2);
  });

  it('offers both providers when the availability cannot be read (the server decides)', async () => {
    const api = fakeRunsApi([]);
    api.respondNext('providers', 503, problem(503, 'Service Unavailable'));
    renderRuns();
    await openDialog();

    expect(
      await within(dialog()).findByText("Couldn't check which providers are available."),
    ).toBeTruthy();
    expect(providerButton('Claude Code').getAttribute('aria-disabled')).toBeNull();
    expect(providerButton('Codex').getAttribute('aria-disabled')).toBeNull();
  });

  it("shows the server's message when it refuses an unavailable provider", async () => {
    const api = fakeRunsApi([]);
    api.respondNext('start', 409, problem(409, 'Provider unavailable', SWITCHED_OFF));
    renderRuns();
    await openDialog();

    await userEvent.type(taskInput(), 'Add pagination');
    await userEvent.click(startButton());

    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toContain('Provider unavailable');
    expect(alert.textContent).toContain(SWITCHED_OFF);
    expect(push).not.toHaveBeenCalled();
  });

  it('re-applies the selection on every opening, also with the same answer (review r1 of #120)', async () => {
    const api = fakeRunsApi([]);
    const claudeOff = [
      { id: 'claude_code', name: 'Claude Code', available: false, reason: SWITCHED_OFF },
      { id: 'codex', name: 'Codex', available: true },
    ];
    api.respondNext('providers', 200, claudeOff);
    api.respondNext('providers', 200, claudeOff);
    renderRuns();

    await openDialog();
    await vi.waitFor(() =>
      expect(providerButton('Codex').getAttribute('aria-pressed')).toBe('true'),
    );
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await openDialog();

    // The second opening's answer may land after the dialog opens (a race on a busy runner,
    // seen on #122): wait for it instead of reading the first render.
    await vi.waitFor(() => expect(api.calls('providers')).toHaveLength(2));
    await vi.waitFor(() =>
      expect(providerButton('Codex').getAttribute('aria-pressed')).toBe('true'),
    );
    expect(providerButton('Claude Code').getAttribute('aria-pressed')).toBe('false');
    await userEvent.type(taskInput(), 'Add pagination');
    await userEvent.click(startButton());
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(api.calls('start')[0]!.body).toEqual({ task: 'Add pagination', provider: 'codex' });
  });

  it("never shows an earlier opening's answer: no provider and no start until the new one", async () => {
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

    expect(within(dialog()).getByRole('status').textContent).toBe(
      'Checking which providers are available…',
    );
    expect(within(dialog()).queryByText(`Codex: ${SWITCHED_OFF}`)).toBeNull();
    expect(providerButton('Claude Code').getAttribute('aria-disabled')).toBe('true');
    expect(providerButton('Codex').getAttribute('aria-disabled')).toBe('true');
    expect(startButton()).toHaveProperty('disabled', true);
    answer(
      new Response(
        JSON.stringify([
          { id: 'claude_code', name: 'Claude Code', available: true },
          { id: 'codex', name: 'Codex', available: true },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await vi.waitFor(() =>
      expect(providerButton('Codex').getAttribute('aria-disabled')).toBeNull(),
    );
    expect(startButton()).toHaveProperty('disabled', false);
  });

  it('keeps an unavailable provider reachable by keyboard, announces why, and never selects it', async () => {
    const api = fakeRunsApi([]);
    api.respondNext('providers', 200, [
      { id: 'claude_code', name: 'Claude Code', available: true },
      { id: 'codex', name: 'Codex', available: false, reason: SWITCHED_OFF },
    ]);
    renderRuns();
    await openDialog();
    const codex = providerButton('Codex');

    codex.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');

    expect(document.activeElement).toBe(codex);
    expect(codex.getAttribute('aria-pressed')).toBe('false');
    expect(document.getElementById(codex.getAttribute('aria-describedby')!)?.textContent).toBe(
      `Codex: ${SWITCHED_OFF}`,
    );
    expect(providerButton('Claude Code').getAttribute('aria-pressed')).toBe('true');
    await expect(document.body).toHaveNoAxeViolations();
  });
});
