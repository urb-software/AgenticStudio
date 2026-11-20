import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RunDetail } from '..';
import { aRun, fakeRunsApi, problem } from './fake-runs-api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const USAGE_LIMIT = {
  code: 'usage_limit' as const,
  detail: 'The Claude Code usage limit was reached; it resets at 2026-11-16T17:00:00.000Z.',
};

function renderRun(runId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RunDetail runId={runId} />
    </QueryClientProvider>,
  );
}

const heading = () => screen.findByRole('heading', { level: 1 });

describe('Run page: resume after the usage limit (Issue #105)', () => {
  it('shows when the limit resets and "Resume run", which queues the Run again', async () => {
    const run = aRun({
      state: 'failed',
      runBranch: 'agent/x-r1',
      failure: USAGE_LIMIT,
      resumable: true,
    });
    const api = fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    expect(screen.getByRole('heading', { name: 'Resume after the usage limit' })).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText("The provider's usage limit was reached.")).toBeTruthy();
    expect(within(alert).getByText(USAGE_LIMIT.detail)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();

    await userEvent.click(screen.getByRole('button', { name: 'Resume run' }));

    expect(await screen.findByText('Answer sent.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume run' })).toBeNull();
    // The resume is the operator's message in the conversation.
    expect(await screen.findByText('Continue where you stopped.')).toBeTruthy();
    expect(api.calls('resume')).toHaveLength(1);
  });

  it('shows why the Run could not be resumed', async () => {
    const run = aRun({ state: 'failed', failure: USAGE_LIMIT, resumable: true });
    const api = fakeRunsApi([run]);
    api.respondNext('resume', 409, problem(409, 'Run not resumable'));
    renderRun(run.id);
    await heading();

    await userEvent.click(screen.getByRole('button', { name: 'Resume run' }));

    expect(await screen.findByText("Couldn't resume the run.")).toBeTruthy();
    expect(screen.getByText('POST /api/runs/{runId}/resume · 409 Run not resumable')).toBeTruthy();
  });

  it('offers no "Resume run" when the API does not say the Run is resumable', async () => {
    const run = aRun({ state: 'failed', failure: USAGE_LIMIT });
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    expect(screen.queryByRole('button', { name: 'Resume run' })).toBeNull();
  });
});
