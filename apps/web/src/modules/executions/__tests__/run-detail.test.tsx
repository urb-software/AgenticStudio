import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunDetail } from '..';
import type { RunOutput } from '../../../platform/api';
import { aRun, fakeRunsApi, problem, PROJECT, SHA } from './fake-runs-api';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

function renderRun(runId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RunDetail runId={runId} />
    </QueryClientProvider>,
  );
}

const heading = () => screen.findByRole('heading', { level: 1 });
const pill = () => document.querySelector<HTMLElement>('[data-slot="status-pill"]')!;

afterEach(() => {
  act(() => focusManager.setFocused(undefined));
  vi.useRealTimers();
});

describe('Run page', () => {
  it('shows the Task, the Provider, the state, the start commit in mono and the times', async () => {
    const run = aRun({
      task: 'Add pagination to products API\nUse cursor paging, 20 per page.',
      provider: 'codex',
      state: 'succeeded',
      createdAt: '2026-11-15T10:00:00.000Z',
      startedAt: '2026-11-15T10:00:05.000Z',
      finishedAt: '2026-11-15T10:04:17.000Z',
    });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);

    expect((await heading()).textContent).toBe('Add pagination to products API');
    expect(pill().textContent).toBe('Succeeded');
    expect(screen.getByText(/Use cursor paging, 20 per page\./)).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
    const commit = screen.getByText(SHA);
    expect(commit.className).toContain('font-mono');
    expect(container.querySelector('time[datetime="2026-11-15T10:00:00.000Z"]')).toBeTruthy();
    expect(container.querySelector('time[datetime="2026-11-15T10:00:05.000Z"]')).toBeTruthy();
    expect(container.querySelector('time[datetime="2026-11-15T10:04:17.000Z"]')).toBeTruthy();
    expect(screen.getByText('4m 12s')).toBeTruthy();
    expect(await screen.findByRole('link', { name: PROJECT.name })).toHaveProperty(
      'href',
      `${window.location.origin}/projects/${PROJECT.id}`,
    );
    await expect(container).toHaveNoAxeViolations();
  });

  it('states the sandbox and the accepted risks of a Codex run, and none for Claude Code (Issue #106)', async () => {
    const codex = aRun({ provider: 'codex', state: 'running' });
    const claude = aRun({ provider: 'claude_code', state: 'running' });
    fakeRunsApi([codex, claude]);
    const { container, unmount } = renderRun(codex.id);
    await heading();

    expect(screen.getByText('Codex workspace-write sandbox, network on')).toBeTruthy();
    expect(screen.getByText(/each run step states it in the log/)).toBeTruthy();
    expect(
      screen.getByText('Two Codex runs may share one ChatGPT plan login at the same time.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Codex runs with the plan login may work on public repositories.'),
    ).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
    unmount();

    renderRun(claude.id);
    await heading();
    expect(screen.queryByText('Accepted risks')).toBeNull();
    expect(screen.queryByText(/workspace-write/)).toBeNull();
  });

  it.each([
    ['queued', 'Queued', 'queued'],
    ['preparing', 'Preparing', 'running'],
    ['running', 'Running', 'running'],
    ['waiting_for_operator', 'Waiting for you', 'awaiting'],
    ['succeeded', 'Succeeded', 'succeeded'],
    ['failed', 'Failed', 'failed'],
    ['cancelled', 'Cancelled', 'cancelled'],
    ['timed_out', 'Timed out', 'failed'],
  ] as const)('presents %s as "%s" on the %s colour', async (state, label, colour) => {
    const run = aRun({ state });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    expect(pill().textContent).toBe(label);
    expect(pill().dataset.status).toBe(colour);
    await expect(container).toHaveNoAxeViolations();
  });

  it.each([
    ['provider_disabled', 'The provider is switched off on this server.'],
    ['preparation_failed', "The run's working copy could not be prepared."],
    ['agent_failed', 'The agent stopped with an error.'],
    ['usage_limit', "The provider's usage limit was reached."],
    ['worker_lost', 'The agent worker stopped responding.'],
    ['delivery_failed', "The run's result could not be delivered."],
    ['step_limit', 'The run reached its maximum number of run steps.'],
    [
      'agent_folder_unavailable',
      "The agent's files are no longer available in the definitions Repository.",
    ],
    ['agent_folder_invalid', "The agent's files in the definitions Repository are not valid."],
    ['model_not_allowed', "The agent's model is not one the provider allows."],
    ['model_refused', "The provider refused the agent's model."],
    ['skills_unusable', "The agent's skills could not be used for this run."],
    ['unknown', 'The run failed for an unknown reason.'],
  ] as const)('shows the message for %s and the detail in mono', async (code, message) => {
    const run = aRun({
      state: 'failed',
      failure: { code, detail: 'fake runner: scripted failure (exit 1)' },
    });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(message)).toBeTruthy();
    expect(within(alert).getByText('fake runner: scripted failure (exit 1)').className).toContain(
      'font-mono',
    );
    await expect(container).toHaveNoAxeViolations();
  });

  it.each([
    [
      { state: 'running', startedAt: '2026-11-15T10:00:05.000Z', environmentFileSupplied: true },
      'Environment file supplied',
    ],
    [
      { state: 'running', startedAt: '2026-11-15T10:00:05.000Z', environmentFileSupplied: false },
      'None',
    ],
    [{ state: 'queued', environmentFileSupplied: false }, 'Decided when the run starts'],
    // A Run that ended without starting (cancelled while queued) was given none.
    [{ state: 'cancelled', environmentFileSupplied: false }, 'None'],
  ] as const)(
    'shows whether the Environment file was supplied (Issue #104): %j',
    async (fields, text) => {
      const run = aRun(fields);
      fakeRunsApi([run]);
      const { container } = renderRun(run.id);
      await heading();

      const term = screen.getByText('Environment file', { selector: 'dt' });
      expect(term.nextElementSibling?.textContent).toBe(text);
      await expect(container).toHaveNoAxeViolations();
    },
  );

  it('says why a queued Run waits when another Run holds the project', async () => {
    const queued = aRun({ state: 'queued' });
    fakeRunsApi([queued, aRun({ state: 'waiting_for_operator' })]);
    const { container } = renderRun(queued.id);

    expect(
      await screen.findByText(
        'Another run is active on this project. This one starts when it finishes.',
      ),
    ).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it("says a queued Run waits for the server's limit when its project is free", async () => {
    const queued = aRun({ state: 'queued' });
    fakeRunsApi([queued, aRun({ state: 'succeeded' })]);
    renderRun(queued.id);

    expect(
      await screen.findByText(
        'Waiting for a free slot: the server runs at most two runs at a time.',
      ),
    ).toBeTruthy();
  });

  it('follows the state without a reload while the Run is active, then stops polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = aRun({ state: 'queued' });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();
    expect(pill().textContent).toBe('Queued');

    api.update(run.id, { state: 'running', startedAt: '2026-11-15T10:00:05.000Z' });
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    await vi.waitFor(() => expect(pill().textContent).toBe('Running'));
    expect(screen.queryByText(/Waiting for a free slot/)).toBeNull();

    api.update(run.id, {
      state: 'failed',
      finishedAt: '2026-11-15T10:01:00.000Z',
      failure: { code: 'agent_failed', detail: 'exit 1' },
    });
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    await vi.waitFor(() => expect(pill().textContent).toBe('Failed'));
    const settled = api.calls('run').length;

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(api.calls('run').length).toBe(settled);
  });

  it('polls a Run waiting for the operator more slowly', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = aRun({ state: 'waiting_for_operator' });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();
    const before = api.calls('run').length;

    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(api.calls('run').length).toBe(before);
    await act(() => vi.advanceTimersByTimeAsync(6_500));
    expect(api.calls('run').length).toBe(before + 1);
  });

  it('pauses polling while the tab is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = aRun({ state: 'running' });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    act(() => focusManager.setFocused(false));
    const hidden = api.calls('run').length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.calls('run').length).toBe(hidden);
  });

  it('keeps the last known Run when a background refresh fails, with a quiet note', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = aRun({ state: 'running' });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    api.respondNext('run', 503, problem(503, 'Service Unavailable'));
    await act(() => vi.advanceTimersByTimeAsync(2_100));

    expect(await screen.findByText(/Couldn't refresh the run\./)).toBeTruthy();
    expect(pill().textContent).toBe('Running');
    expect((await heading()).textContent).toBe(run.task);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['succeeded', 'failed', 'cancelled', 'timed_out'] as const)(
    'offers Run again on a %s Run, prefilled with its Task and agent',
    async (state) => {
      const run = aRun({
        state,
        task: 'Add pagination\nUse cursors.',
        provider: 'codex',
        agent: { ...aRun().agent, name: 'default-codex', provider: 'codex' },
      });
      const api = fakeRunsApi([run]);
      renderRun(run.id);
      await heading();

      await userEvent.click(screen.getByRole('button', { name: 'Run again' }));
      const dialog = screen.getByRole('dialog', { name: 'New run' });
      expect(within(dialog).getByLabelText<HTMLTextAreaElement>('Task').value).toBe(
        'Add pagination\nUse cursors.',
      );
      await vi.waitFor(() =>
        expect(within(dialog).getByLabelText<HTMLSelectElement>('Agent').value).toBe(
          'default-codex',
        ),
      );
      await vi.waitFor(() =>
        expect(
          within(dialog).getByRole('button', { name: 'Start run' }).hasAttribute('disabled'),
        ).toBe(false),
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Start run' }));

      await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
      expect(api.calls('start')[0]!.body).toEqual({
        task: 'Add pagination\nUse cursors.',
        agent: 'default-codex',
      });
      push.mockReset();
    },
  );

  it("offers the preselected agent when the Run's agent is no longer among the usable ones", async () => {
    const run = aRun({
      state: 'failed',
      agent: { ...aRun().agent, name: 'removed-agent', source: 'definitions', commit: SHA },
    });
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    await userEvent.click(screen.getByRole('button', { name: 'Run again' }));
    const dialog = screen.getByRole('dialog', { name: 'New run' });

    await vi.waitFor(() =>
      expect(within(dialog).getByLabelText<HTMLSelectElement>('Agent').value).toBe(
        'default-claude-code',
      ),
    );
    const note = within(dialog).getByTestId('agent-fallback-note');
    expect(note.textContent).toContain('removed-agent');
    await expect(document.body).toHaveNoAxeViolations();
  });

  it("moves Run again to an agent with an available Provider when the Run's own is switched off (Issue #101)", async () => {
    const run = aRun({
      state: 'failed',
      provider: 'codex',
      agent: { ...aRun().agent, name: 'default-codex', provider: 'codex' },
    });
    const api = fakeRunsApi([run]);
    api.respondNext('providers', 200, [
      { id: 'claude_code', name: 'Claude Code', available: true },
      { id: 'codex', name: 'Codex', available: false, reason: 'Switched off on the agent worker' },
    ]);
    renderRun(run.id);
    await heading();

    await userEvent.click(screen.getByRole('button', { name: 'Run again' }));
    const dialog = screen.getByRole('dialog', { name: 'New run' });

    await vi.waitFor(() =>
      expect(within(dialog).getByLabelText<HTMLSelectElement>('Agent').value).toBe(
        'default-claude-code',
      ),
    );
    expect(
      within(dialog).getByRole<HTMLOptionElement>('option', { name: /default-codex/ }).disabled,
    ).toBe(true);
  });

  it('re-applies it on every Run again, also with the same answer (review r1 of #120)', async () => {
    const run = aRun({
      state: 'failed',
      provider: 'codex',
      agent: { ...aRun().agent, name: 'default-codex', provider: 'codex' },
    });
    const api = fakeRunsApi([run]);
    const codexOff = [
      { id: 'claude_code', name: 'Claude Code', available: true },
      { id: 'codex', name: 'Codex', available: false, reason: 'Switched off on the agent worker' },
    ];
    api.respondNext('providers', 200, codexOff);
    api.respondNext('providers', 200, codexOff);
    renderRun(run.id);
    await heading();
    const chosen = () =>
      within(screen.getByRole('dialog', { name: 'New run' })).getByLabelText<HTMLSelectElement>(
        'Agent',
      ).value;

    await userEvent.click(screen.getByRole('button', { name: 'Run again' }));
    await vi.waitFor(() => expect(chosen()).toBe('default-claude-code'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Run again' }));

    await vi.waitFor(() => expect(api.calls('providers')).toHaveLength(2));
    await vi.waitFor(() => expect(chosen()).toBe('default-claude-code'));
  });

  it.each(['queued', 'preparing', 'running', 'waiting_for_operator'] as const)(
    'has no Run again while the Run is %s',
    async (state) => {
      const run = aRun({ state });
      fakeRunsApi([run]);
      renderRun(run.id);
      await heading();

      expect(screen.queryByRole('button', { name: 'Run again' })).toBeNull();
    },
  );

  it('shows a not-found state for an unknown Run', async () => {
    fakeRunsApi([]);
    renderRun('00000000-0000-4000-8000-00000000dead');

    expect(await screen.findByRole('heading', { name: 'Run not found' })).toBeTruthy();
  });

  it('shows the failed request with Retry, which recovers', async () => {
    const run: RunOutput = aRun({ state: 'running' });
    const api = fakeRunsApi([run]);
    api.respondNext('run', 503, problem(503, 'Service Unavailable'));
    renderRun(run.id);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('GET /api/runs/{runId} · 503 Service Unavailable')).toBeTruthy();
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect((await heading()).textContent).toBe(run.task);
  });
});

describe('Run page: the agent that ran', () => {
  const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
  const fact = (term: string) => {
    const dt = screen.getByText(term, { selector: 'dt' });
    return dt.parentElement!.querySelector('dd')!;
  };
  const withAgent = (agent: Partial<RunOutput['agent']>) =>
    aRun({ state: 'succeeded', agent: { ...aRun().agent, ...agent } });

  it('names a built-in agent as Built in, with its Provider and model and no commit', async () => {
    const run = aRun({ state: 'succeeded' });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    expect(fact('Agent').textContent).toContain('default-claude-code');
    expect(fact('Agent').textContent).toContain('Built in');
    expect(fact('Provider').textContent).toBe('Claude Code');
    expect(fact('Model').textContent).toBe('default');
    expect(screen.queryByText('Agent commit', { selector: 'dt' })).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('names a definitions agent with its commit, short with the full id on hover', async () => {
    const run = withAgent({
      name: 'reviewer',
      source: 'definitions',
      commit: COMMIT,
      provider: 'codex',
      model: 'gpt-5',
      instructions: 'Review carefully.',
    });
    fakeRunsApi([{ ...run, provider: 'codex' }]);
    const { container } = renderRun(run.id);
    await heading();

    expect(fact('Agent').textContent).toContain('reviewer');
    expect(fact('Agent').textContent).toContain('From the definitions Repository');
    const commit = fact('Agent commit').querySelector('code')!;
    expect(commit.textContent).toBe(COMMIT.slice(0, 8));
    expect(commit.getAttribute('title')).toBe(COMMIT);
    expect(fact('Provider').textContent).toBe('Codex');
    expect(fact('Model').textContent).toBe('gpt-5');
    await expect(container).toHaveNoAxeViolations();
  });

  it('keeps the instructions collapsed, then shows them as plain text with their line breaks', async () => {
    const run = withAgent({ instructions: 'Line one.\n\n  Line two.' });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    const details = container.querySelector<HTMLDetailsElement>(
      'details[data-slot="agent-instructions"]',
    )!;
    expect(details.open).toBe(false);
    await userEvent.click(within(details).getByText('Show instructions'));
    expect(details.open).toBe(true);
    const text = within(details).getByTestId('agent-instructions-text');
    expect(text.tagName).toBe('PRE');
    expect(text.className).toContain('whitespace-pre-wrap');
    expect(text.textContent).toBe('Line one.\n\n  Line two.');
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows markup and Markdown in the instructions as text: no link, no script, no element', async () => {
    const instructions =
      '<a href="https://evil.example">click</a><script>window.__pwned = 1</script>\n[md](https://evil.example/md) **bold** <img src=x onerror="window.__pwned = 2">';
    const run = withAgent({ instructions });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    const details = container.querySelector<HTMLDetailsElement>(
      'details[data-slot="agent-instructions"]',
    )!;
    await userEvent.click(within(details).getByText('Show instructions'));
    const text = within(details).getByTestId('agent-instructions-text');

    expect(text.textContent).toBe(instructions);
    expect(details.querySelector('a, script, img, strong')).toBeNull();
    expect(within(details).queryByRole('link')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('says there are no instructions when the agent has none, with nothing to expand', async () => {
    const run = aRun({ state: 'succeeded' });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    expect(container.querySelector('details[data-slot="agent-instructions"]')).toBeNull();
    expect(fact('Agent instructions').textContent).toBe('None');
  });
});
