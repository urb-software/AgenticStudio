import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunDetail } from '..';
import { RunRows } from '../components/run-rows';
import { aRun, fakeRunsApi, problem } from './fake-runs-api';

// Issue #102 on the Run page seam: how a Run's result reached GitHub, with the generated client,
// the API wrapper and TanStack Query real, and the API faked at `fetch`.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const BRANCH = 'agent/add-pagination-r0b8e5c2d';
const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };

function renderRun(runId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RunDetail runId={runId} />
    </QueryClientProvider>,
  );
}

const heading = () => screen.findByRole('heading', { level: 1 });

afterEach(() => vi.useRealTimers());

describe('Run page: delivery (Issue #102)', () => {
  it('shows the Run branch and links the draft pull request', async () => {
    const run = aRun({
      state: 'succeeded',
      runBranch: BRANCH,
      commits: [{ id: 'c'.repeat(40), subject: 'Add pagination' }],
      hasUncommittedChanges: false,
      delivery: 'delivered',
      pullRequest: PULL_REQUEST,
    });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    const banner = screen.getByText('Draft pull request opened.').closest('[data-slot="banner"]');
    const link = within(banner as HTMLElement).getByRole('link', { name: /Pull request #7/ });
    expect(link.getAttribute('href')).toBe(PULL_REQUEST.url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    const branch = screen.getAllByText(BRANCH);
    expect(branch.length).toBeGreaterThan(0);
    expect(branch.every((element) => element.className.includes('font-mono'))).toBe(true);
    expect(screen.queryByText('No changes.')).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says "No changes" when nothing was pushed for a succeeded Run', async () => {
    const run = aRun({ state: 'succeeded', runBranch: BRANCH, delivery: 'none' });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    expect(screen.getByText('No changes.')).toBeTruthy();
    expect(
      screen.getByText(
        'The agent changed nothing, so nothing was pushed and no pull request was opened.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Pull request/ })).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says plainly that checks failed, and that the pull request says so too', async () => {
    const run = aRun({
      state: 'succeeded',
      runBranch: BRANCH,
      delivery: 'delivered',
      pullRequest: PULL_REQUEST,
      failingChecks: ['unit tests', 'lint'],
    });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    const banner = screen.getByText('Some checks failed.').closest('[data-slot="banner"]');
    expect(banner?.textContent).toContain(
      'The agent reported these checks as failed: unit tests, lint. The pull request says so too.',
    );
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows a failed delivery with its reason and "Retry delivery", which asks for a retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = aRun({
      state: 'failed',
      runBranch: BRANCH,
      delivery: 'failed',
      failure: {
        code: 'delivery_failed',
        detail: 'Pushing the Run branch was refused by branch protection.',
      },
    });
    const api = fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText("The run's result could not be delivered.")).toBeTruthy();
    expect(
      within(alert).getByText('Pushing the Run branch was refused by branch protection.'),
    ).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();

    await userEvent.click(screen.getByRole('button', { name: 'Retry delivery' }));

    expect(await screen.findByText('Retrying the delivery.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry delivery' })).toBeNull();
    expect(api.calls('retryDelivery')).toHaveLength(1);

    // The worker delivers on the retry; the page follows without a reload.
    api.update(run.id, {
      state: 'succeeded',
      failure: undefined,
      delivery: 'delivered',
      pullRequest: PULL_REQUEST,
      deliveryRetryRequested: undefined,
    });
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(await screen.findByText('Draft pull request opened.')).toBeTruthy();
  });

  it('shows why a retry could not be asked for', async () => {
    const run = aRun({
      state: 'failed',
      delivery: 'failed',
      failure: { code: 'delivery_failed', detail: 'GitHub answered 503.' },
    });
    const api = fakeRunsApi([run]);
    api.respondNext('retryDelivery', 409, problem(409, 'Delivery not retryable'));
    renderRun(run.id);
    await heading();

    await userEvent.click(screen.getByRole('button', { name: 'Retry delivery' }));

    expect(await screen.findByText("Couldn't retry the delivery.")).toBeTruthy();
    expect(
      screen.getByText('POST /api/runs/{runId}/retry-delivery · 409 Delivery not retryable'),
    ).toBeTruthy();
  });

  it('offers no "Retry delivery" for a Run that failed for another reason', async () => {
    const run = aRun({
      state: 'failed',
      runBranch: BRANCH,
      failure: { code: 'agent_failed', detail: 'exit 1' },
    });
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    expect(screen.queryByRole('button', { name: 'Retry delivery' })).toBeNull();
  });

  it.each([
    ['failed', { failure: { code: 'agent_failed' as const, detail: 'exit 1' } }],
    ['cancelled', {}],
    ['timed_out', {}],
  ] as const)('says where the Run branch stays for a %s Run', async (state, extra) => {
    const run = aRun({ state, runBranch: BRANCH, ...extra });
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();

    const banner = screen.getByText('Nothing was pushed.').closest('[data-slot="banner"]');
    expect(banner?.textContent).toContain(
      `The Run branch ${BRANCH} stays in the Working copy on the agent worker until retention removes it.`,
    );
    await expect(container).toHaveNoAxeViolations();
  });

  it('reminds about branch protection on the first delivery to the repository only', async () => {
    const first = aRun({
      state: 'succeeded',
      delivery: 'delivered',
      pullRequest: PULL_REQUEST,
      createdAt: '2026-11-15T10:00:00.000Z',
    });
    const second = aRun({
      state: 'succeeded',
      delivery: 'delivered',
      pullRequest: { ...PULL_REQUEST, number: 8, url: 'https://github.com/acme/shop/pull/8' },
      createdAt: '2026-11-15T11:00:00.000Z',
    });
    fakeRunsApi([second, first]);

    const { unmount } = renderRun(first.id);
    expect(await screen.findByText('First delivery to this repository.')).toBeTruthy();
    unmount();

    renderRun(second.id);
    await heading();
    await screen.findByText('Draft pull request opened.');
    // The project's Runs are read; the earlier Run was delivered.
    await vi.waitFor(() =>
      expect(screen.queryByText('First delivery to this repository.')).toBeNull(),
    );
  });
});

describe('Runs list: pull request marker (Issue #102)', () => {
  it('marks a delivered Run with its pull request number', () => {
    const delivered = aRun({
      state: 'succeeded',
      delivery: 'delivered',
      pullRequest: PULL_REQUEST,
    });
    const plain = aRun({ state: 'succeeded', delivery: 'none' });
    render(<RunRows runs={[delivered, plain]} now={Date.now()} label="Runs" />);

    const [first, second] = screen.getAllByRole('listitem');
    expect(within(first!).getByText('Pull request')).toBeTruthy();
    expect(first!.textContent).toContain('#7');
    expect(within(second!).queryByText('Pull request')).toBeNull();
  });
});
