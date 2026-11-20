import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionsOverview, RunDetail } from '..';
import type { RunOutput } from '../../../platform/api';
import { aRun, fakeRunsApi, problem } from './fake-runs-api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const URL_OF_PULL_REQUEST = 'https://github.com/acme/shop/pull/7';
const BRANCH = 'agent/add-a-health-check-r1';
const REFRESHED = '2026-11-16T12:00:00.000Z';

function renderWith(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const renderRun = (runId: string) => renderWith(<RunDetail runId={runId} />);
const heading = () => screen.findByRole('heading', { level: 1 });
const card = () => screen.getByRole('region', { name: 'Pull request' });

/** A delivered Run with a pull request whose state is as given. */
function delivered(
  pullRequest: Partial<NonNullable<RunOutput['pullRequest']>> = {},
  overrides: Partial<RunOutput> = {},
): RunOutput {
  return aRun({
    task: 'Add a health check',
    state: 'succeeded',
    startedAt: '2026-11-16T11:00:01.000Z',
    finishedAt: '2026-11-16T11:05:00.000Z',
    runBranch: BRANCH,
    delivery: 'delivered',
    pullRequest: { url: URL_OF_PULL_REQUEST, number: 7, ...pullRequest },
    steps: { used: 1, usedInPart: 1 },
    followUp: { allowed: true },
    ...overrides,
  });
}

afterEach(() => vi.useRealTimers());

describe('Run page: the pull request card (Issue #142)', () => {
  it('shows the number and link, the state, the branch, the position, the verdict and when it was read', async () => {
    const run = delivered({
      state: 'draft',
      behindBy: 2,
      aheadBy: 3,
      mergeable: true,
      refreshedAt: REFRESHED,
    });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    const section = card();
    const link = within(section).getByRole('link', { name: /#7/ });
    expect(link.getAttribute('href')).toBe(URL_OF_PULL_REQUEST);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(within(section).getByText('Draft')).toBeTruthy();
    expect(within(section).getByText(BRANCH)).toBeTruthy();
    expect(section.textContent).toContain('2 commits behind · 3 commits ahead');
    expect(section.textContent).toContain('Can be merged without conflicts');
    expect(within(section).getByText(/Nov 16, 2026/)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it.each([
    ['open', 'Open'],
    ['merged', 'Merged'],
    ['closed', 'Closed'],
    ['missing', 'Missing'],
  ] as const)('shows a %s pull request', async (state, label) => {
    const run = delivered({ state, refreshedAt: REFRESHED });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    expect(within(card()).getByText(label)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says a conflict, and that GitHub has not said yet', async () => {
    const run = delivered({ state: 'open', mergeable: false, refreshedAt: REFRESHED });
    const other = delivered({ state: 'open', refreshedAt: REFRESHED });
    fakeRunsApi([run, other]);

    const { unmount } = renderRun(run.id);
    await heading();
    expect(card().textContent).toContain('Has conflicts with the integration branch');
    unmount();
    renderRun(other.id);
    await heading();
    expect(card().textContent).toContain('GitHub has not said yet');
  });

  it('says the state has not been checked yet, and when it was never read', async () => {
    const run = delivered();
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    expect(within(card()).getByText('Not checked yet')).toBeTruthy();
    expect(within(card()).getByText('Not read yet')).toBeTruthy();
  });

  it('has no card for a Run without a pull request, and asks for nothing', async () => {
    const run = aRun({ state: 'succeeded', delivery: 'none' });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    expect(screen.queryByRole('region', { name: 'Pull request' })).toBeNull();
    expect(api.calls('refresh')).toHaveLength(0);
  });
});

describe('Run page: refreshing the state (Issue #142)', () => {
  it('asks for a refresh when the page opens, saying it is the page asking', async () => {
    const run = delivered({ state: 'open', refreshedAt: REFRESHED });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    await vi.waitFor(() => expect(api.calls('refresh')).toHaveLength(1));
    expect(api.calls('refresh')[0]?.body).toEqual({ onOpen: true });
  });

  it('asks again with "Refresh", as the operator', async () => {
    const run = delivered({ state: 'open', refreshedAt: REFRESHED });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();
    await vi.waitFor(() => expect(api.calls('refresh')).toHaveLength(1));

    await userEvent.click(within(card()).getByRole('button', { name: 'Refresh' }));

    await vi.waitFor(() => expect(api.calls('refresh')).toHaveLength(2));
    expect(api.calls('refresh')[1]?.body).toBeUndefined();
  });

  it('shows a loading state while a worker reads the pull request, then the new state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = delivered({ state: 'draft', refreshedAt: REFRESHED, refreshing: true });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    expect(within(card()).getByRole('status').textContent).toContain(
      'Refreshing the state from GitHub',
    );
    expect(
      (within(card()).getByRole('button', { name: /Refresh/ }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // The worker answered: the page follows it.
    api.update(run.id, {
      pullRequest: { url: URL_OF_PULL_REQUEST, number: 7, state: 'merged', refreshedAt: REFRESHED },
      followUp: { allowed: false, reason: 'pull_request_merged' },
    });
    await act(() => vi.advanceTimersByTimeAsync(2_100));

    expect(await within(card()).findByText('Merged')).toBeTruthy();
    expect(within(card()).queryByRole('status')).toBeNull();
  });

  it('says when GitHub asked to wait, while the refresh waits for its retry', async () => {
    const run = delivered({
      state: 'open',
      refreshedAt: REFRESHED,
      refreshing: true,
      refreshError: 'GitHub asked to wait (300 seconds) before the pull request is read again.',
      retryAt: '2026-11-16T12:05:00.000Z',
    });
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    expect(within(card()).getByRole('status').textContent).toMatch(
      /GitHub asked to wait; it tries again at Nov 16, 2026/,
    );
    // The last known state stays on the card.
    expect(within(card()).getByText('Open')).toBeTruthy();
  });

  it('keeps the last known state and says the refresh failed', async () => {
    const run = delivered({
      state: 'open',
      behindBy: 1,
      aheadBy: 1,
      refreshedAt: REFRESHED,
      refreshError: 'Reading the pull request failed: GitHub answered 401. Check the token.',
    });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    const warning = within(card()).getByRole('status');
    expect(warning.textContent).toContain('The state could not be refreshed.');
    expect(warning.textContent).toContain('GitHub answered 401');
    expect(warning.textContent).toContain('last known state');
    expect(within(card()).getByText('Open')).toBeTruthy();
    expect(card().textContent).toContain('1 commit behind · 1 commit ahead');
    await expect(container).toHaveNoAxeViolations();
  });

  it('says no agent worker is connected, and that a Follow-up is still possible when the state is unknown', async () => {
    const run = delivered({
      refreshError:
        'The agent worker is not connected, so the pull request state could not be refreshed.',
    });
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    const warning = within(card()).getByRole('status');
    expect(warning.textContent).toContain('The state could not be checked.');
    expect(warning.textContent).toContain('agent worker is not connected');
    expect(warning.textContent).toContain('A Follow-up is still possible.');
    // The Follow-up is allowed: its form is there.
    expect(screen.getByRole('region', { name: 'Send a Follow-up' })).toBeTruthy();
  });

  it('shows why a refresh request itself failed', async () => {
    const run = delivered({ state: 'open', refreshedAt: REFRESHED });
    const api = fakeRunsApi([run]);
    api.respondNext('refresh', 500, problem(500, 'Internal Server Error'));
    renderRun(run.id);
    await heading();

    expect(await screen.findByText("Couldn't refresh the state.")).toBeTruthy();
    expect(screen.getByText(/POST \/api\/runs\/\{runId\}\/pull-request\/refresh/)).toBeTruthy();
  });
});

describe('Run page: Follow-up by pull request state (Issue #142)', () => {
  it.each([
    ['pull_request_merged', 'The pull request was merged on GitHub'],
    ['pull_request_closed', 'The pull request was closed on GitHub'],
    ['pull_request_missing', 'was not found on GitHub'],
  ] as const)(
    'replaces the Follow-up form with the reason (%s) and offers "Run again"',
    async (reason, words) => {
      const state = reason.replace('pull_request_', '') as 'merged' | 'closed' | 'missing';
      const run = delivered(
        { state, refreshedAt: REFRESHED },
        { followUp: { allowed: false, reason } },
      );
      fakeRunsApi([run]);
      const { container } = renderRun(run.id);
      await heading();

      const section = screen.getByRole('region', { name: 'Follow-up not possible' });
      expect(section.textContent).toContain(words);
      expect(section.textContent).toContain('Use “Run again”');
      expect(screen.queryByRole('region', { name: 'Send a Follow-up' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Run again' })).toBeTruthy();
      await expect(container).toHaveNoAxeViolations();
    },
  );

  it('offers the Follow-up again once a refresh finds the closed pull request reopened', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = delivered(
      { state: 'closed', refreshedAt: REFRESHED },
      { followUp: { allowed: false, reason: 'pull_request_closed' } },
    );
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();
    expect(screen.queryByRole('region', { name: 'Send a Follow-up' })).toBeNull();

    api.update(run.id, {
      pullRequest: {
        url: URL_OF_PULL_REQUEST,
        number: 7,
        state: 'open',
        refreshedAt: '2026-11-16T12:30:00.000Z',
      },
      followUp: { allowed: true },
    });
    await userEvent.click(within(card()).getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('region', { name: 'Send a Follow-up' })).toBeTruthy();
    expect(within(card()).getByText('Open')).toBeTruthy();
  });
});

describe('Runs lists: the pull request state (Issue #142)', () => {
  it('does not poll a list for a refresh: only the Run page follows one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = delivered({ state: 'open', refreshedAt: REFRESHED, refreshing: true });
    const api = fakeRunsApi([run]);
    renderWith(<ExecutionsOverview />);
    await screen.findByRole('list', { name: 'Runs' });
    const reads = api.calls('runs').length;

    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(api.calls('runs')).toHaveLength(reads);
  });

  it('shows the state next to the pull request marker', async () => {
    const draft = delivered({ state: 'draft', refreshedAt: REFRESHED }, { task: 'Draft run' });
    const merged = delivered(
      { state: 'merged', number: 8, url: 'https://github.com/acme/shop/pull/8' },
      { task: 'Merged run' },
    );
    const unknown = delivered(
      { number: 9, url: 'https://github.com/acme/shop/pull/9' },
      { task: 'Unknown run' },
    );
    fakeRunsApi([draft, merged, unknown]);
    renderWith(<ExecutionsOverview />);

    const list = await screen.findByRole('list', { name: 'Runs' });
    const rows = within(list).getAllByRole('listitem');
    const rowOf = (task: string) => rows.find((row) => row.textContent?.includes(task))!;
    expect(rowOf('Draft run').textContent).toMatch(/#7.*Draft/);
    expect(rowOf('Merged run').textContent).toMatch(/#8.*Merged/);
    // Not read yet: only the marker.
    expect(rowOf('Unknown run').textContent).toMatch(/#9/);
    expect(rowOf('Unknown run').textContent).not.toMatch(/Draft|Open|Merged|Closed|Missing/);
  });
});
