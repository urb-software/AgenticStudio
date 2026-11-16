import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunIndicator } from '..';
import type { RunOutput } from '../../../platform/api';
import { aRun, fakeRunsApi } from './fake-runs-api';

// Run indicator seam (Story #97): the public RunIndicator of the executions module, with the
// generated client, the API wrapper and TanStack Query real, and the API faked at `fetch`. It
// reads the two counts of `GET /api/runs/summary`, never the Run list (Issue #115).

function renderIndicator() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RunIndicator />
    </QueryClientProvider>,
  );
}

const indicator = () => screen.findByRole('link', { name: /running|waiting/ });
const runsIn = (...list: RunOutput['state'][]) => list.map((state) => aRun({ state }));

afterEach(() => {
  vi.useRealTimers();
});

describe('Run indicator', () => {
  it.each([
    ['one running Run', runsIn('running'), '1 running'],
    ['queued and preparing Runs as running', runsIn('queued', 'preparing', 'running'), '3 running'],
    ['a Run waiting for the operator', runsIn('waiting_for_operator'), '1 waiting for you'],
    [
      'both, ignoring finished Runs',
      runsIn('running', 'waiting_for_operator', 'succeeded', 'failed'),
      '1 running · 1 waiting for you',
    ],
  ])('counts %s', async (_, runs, text) => {
    fakeRunsApi(runs);
    const { container } = renderIndicator();

    const link = await indicator();
    expect(link.textContent).toContain(text);
    expect(link.getAttribute('href')).toBe('/executions');
    await expect(container).toHaveNoAxeViolations();
  });

  it('reads the summary, not the list of every Run', async () => {
    const api = fakeRunsApi(runsIn('running', 'waiting_for_operator'));
    renderIndicator();

    await indicator();
    expect(api.calls('summary')).toHaveLength(1);
    expect(api.calls('runs')).toHaveLength(0);
  });

  it('is amber only when a Run waits for the operator', async () => {
    fakeRunsApi(runsIn('running', 'waiting_for_operator'));
    const { unmount } = renderIndicator();

    const waiting = await indicator();
    expect(waiting.className).toContain('text-run-awaiting');
    expect(waiting.className).not.toContain('text-run-running');
    unmount();

    fakeRunsApi(runsIn('queued', 'running'));
    renderIndicator();

    const running = await indicator();
    expect(running.className).toContain('text-run-running');
    expect(running.className).not.toContain('text-run-awaiting');
  });

  it('is hidden when no Run is active or waiting', async () => {
    const api = fakeRunsApi(runsIn('succeeded', 'cancelled', 'timed_out'));
    renderIndicator();

    await vi.waitFor(() => expect(api.calls('summary')).toHaveLength(1));
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('disappears when the last active Run finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = aRun({ state: 'running' });
    const api = fakeRunsApi([run]);
    renderIndicator();
    await indicator();

    api.update(run.id, { state: 'succeeded' });
    await act(() => vi.advanceTimersByTimeAsync(2_100));

    await vi.waitFor(() => expect(screen.queryByRole('link')).toBeNull());
  });
});
