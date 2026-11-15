import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunDetail } from '..';
import { aRun, fakeRunsApi } from './fake-runs-api';

// Story #100 seam: cancelling a Run and the limits on the public RunDetail, with the generated
// client, the API wrapper and TanStack Query real, and the API faked at `fetch`.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

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
const cancelButton = () => screen.queryByRole('button', { name: 'Cancel run' });

async function openDialog() {
  await userEvent.click(cancelButton()!);
  return screen.getByRole('alertdialog', { name: 'Cancel run' });
}

afterEach(() => {
  act(() => focusManager.setFocused(undefined));
  document.documentElement.classList.remove('dark');
  vi.useRealTimers();
});

describe('Cancel run (Issue #100)', () => {
  it.each(['queued', 'preparing', 'running', 'waiting_for_operator'] as const)(
    'offers "Cancel run" on a %s Run, as a danger button',
    async (state) => {
      const run = aRun({ state });
      fakeRunsApi([run]);
      renderRun(run.id);
      await heading();

      expect(cancelButton()?.dataset.variant).toBe('danger');
    },
  );

  it.each(['succeeded', 'failed', 'cancelled', 'timed_out'] as const)(
    'has no "Cancel run" on a %s Run',
    async (state) => {
      const run = aRun({ state });
      fakeRunsApi([run]);
      renderRun(run.id);
      await heading();

      expect(cancelButton()).toBeNull();
    },
  );

  it('confirms in a destructive dialog that says what happens and what is kept', async () => {
    const run = aRun({ state: 'running', task: 'Add pagination\nUse cursors.' });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    const dialog = await openDialog();

    expect(within(dialog).getByText('Add pagination')).toBeTruthy();
    expect(within(dialog).getByText('The agent is stopped.')).toBeTruthy();
    expect(within(dialog).getByText('Nothing is pushed.')).toBeTruthy();
    expect(within(dialog).getByText('The working copy is kept for inspection.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Cancel run' }).dataset.variant).toBe(
      'destructive',
    );
    // Focus is inside the dialog, and Tab keeps it there (focus trap).
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 5; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    // A bottom sheet below 768px (the Dialog's phone layout).
    expect(dialog.className.split(' ')).toEqual(
      expect.arrayContaining(['fixed', 'inset-x-0', 'bottom-0']),
    );
    await expect(document.body).toHaveNoAxeViolations();
    document.documentElement.classList.add('dark');
    await expect(document.body).toHaveNoAxeViolations();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep run' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.calls('cancel')).toHaveLength(0);
  });

  it('cancels a queued Run at once: the page shows it cancelled by the operator', async () => {
    const run = aRun({ state: 'queued' });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel run' }));

    await vi.waitFor(() => expect(pill().textContent).toBe('Cancelled'));
    expect(api.calls('cancel')).toHaveLength(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('Cancelled by the operator.')).toBeTruthy();
    expect(cancelButton()).toBeNull();
  });

  it('shows "Cancel requested…" on a running Run until the worker confirms', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = aRun({ state: 'running' });
    const api = fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel run' }));

    const pending = await screen.findByRole('button', { name: 'Cancel requested…' });
    expect(pending).toHaveProperty('disabled', true);
    expect(screen.getByText(/The agent worker is stopping the run/)).toBeTruthy();
    expect(pill().textContent).toBe('Running');
    await expect(container).toHaveNoAxeViolations();

    api.update(run.id, {
      state: 'cancelled',
      finishedAt: '2026-11-15T10:05:00.000Z',
      cancellation: { by: 'operator', reason: 'Cancelled by the operator.' },
    });
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    await vi.waitFor(() => expect(pill().textContent).toBe('Cancelled'));
    expect(screen.queryByRole('button', { name: 'Cancel requested…' })).toBeNull();
  });

  it('reports a Run that finished meanwhile clearly, in the dialog', async () => {
    const run = aRun({ state: 'running' });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();
    const dialog = await openDialog();
    api.update(run.id, { state: 'succeeded', finishedAt: '2026-11-15T10:05:00.000Z' });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel run' }));

    const alert = await within(dialog).findByRole('alert');
    expect(within(alert).getByText('Run already finished')).toBeTruthy();
    expect(within(alert).getByText(/There is nothing to cancel/)).toBeTruthy();
  });

  it('says who cancelled a Run and why: Studio, after a long wait', async () => {
    const run = aRun({
      state: 'cancelled',
      finishedAt: '2026-11-29T10:00:00.000Z',
      cancellation: {
        by: 'system',
        reason: 'Cancelled automatically: the run waited for the operator longer than 14 days.',
      },
    });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    expect(
      screen.getByText(
        'Cancelled automatically: the run waited for the operator longer than 14 days.',
      ),
    ).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says a timed-out Run stopped at its time limit', async () => {
    const run = aRun({
      state: 'timed_out',
      finishedAt: '2026-11-15T11:00:00.000Z',
      limits: { stepMinutes: 45, maxSteps: 10, waitingDays: 14 },
    });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    expect(
      screen.getByText('The run step reached its time limit of 45 minutes and was stopped.'),
    ).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows the limits in force on the Run page', async () => {
    const run = aRun({
      state: 'running',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14 },
    });
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    const limits = screen.getByText('Limits', { selector: 'dt' }).nextElementSibling!;
    expect(limits.textContent).toContain('60 minutes per run step');
    expect(limits.textContent).toContain('at most 10 run steps');
    expect(limits.textContent).toContain('cancelled after 14 days waiting for you');
  });

  it('says a Run cancelled during its delivery left a draft pull request (review of #121)', async () => {
    const run = aRun({
      state: 'cancelled',
      finishedAt: '2026-11-15T10:05:00.000Z',
      cancellation: { by: 'operator', reason: 'Cancelled by the operator.' },
      delivery: 'delivered',
      pullRequest: { url: 'https://github.com/acme/shop/pull/9', number: 9 },
      runBranch: 'agent/x-r1',
      commits: [],
      hasUncommittedChanges: false,
    });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    expect(
      screen.getByText('Cancelled during its delivery: a draft pull request was opened.'),
    ).toBeTruthy();
    const banner = screen
      .getByText('Cancelled during its delivery: a draft pull request was opened.')
      .closest('[data-tone]') as HTMLElement;
    expect(within(banner).getByRole('link', { name: /Pull request #9/ })).toHaveProperty(
      'href',
      'https://github.com/acme/shop/pull/9',
    );
    expect(screen.queryByText('Nothing was pushed.')).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });
});
