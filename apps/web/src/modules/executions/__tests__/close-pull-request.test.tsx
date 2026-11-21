import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunDetail } from '..';
import type { RunOutput } from '../../../platform/api';
import { aRun, fakeRunsApi, problem } from './fake-runs-api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

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
const card = () => screen.getByRole('region', { name: 'Pull request' });
const closeButton = () => within(card()).queryByRole('button', { name: 'Close without merging' });

/** A finished Run with a draft pull request, when Studio can merge. */
function delivered(overrides: Partial<RunOutput> = {}): RunOutput {
  return aRun({
    state: 'succeeded',
    startedAt: '2026-11-16T11:00:01.000Z',
    finishedAt: '2026-11-16T11:05:00.000Z',
    runBranch: 'agent/add-a-health-check-r1',
    delivery: 'delivered',
    pullRequest: {
      ...PULL_REQUEST,
      state: 'draft',
      refreshedAt: '2026-11-16T12:00:00.000Z',
    },
    steps: { used: 1, usedInPart: 1 },
    merge: { available: true },
    ...overrides,
  });
}

afterEach(() => vi.useRealTimers());

describe('Run page: Close without merging', () => {
  it.each(['draft', 'open'] as const)(
    'is offered for a finished Run with a %s pull request',
    async (state) => {
      const run = delivered({ pullRequest: { ...PULL_REQUEST, state } });
      fakeRunsApi([run]);
      renderRun(run.id);
      await heading();

      expect(closeButton()?.dataset.variant).toBe('danger');
    },
  );

  it.each([
    ['a merged pull request', { pullRequest: { ...PULL_REQUEST, state: 'merged' as const } }],
    ['a closed pull request', { pullRequest: { ...PULL_REQUEST, state: 'closed' as const } }],
    ['a missing pull request', { pullRequest: { ...PULL_REQUEST, state: 'missing' as const } }],
    ['a Run that is still working', { state: 'running' as const, finishedAt: undefined }],
  ])('is not offered for %s', async (_name, overrides) => {
    const run = delivered(overrides);
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    expect(closeButton()).toBeNull();
  });

  it('is not offered for a Run without a pull request', async () => {
    const run = aRun({ state: 'succeeded', delivery: 'none', merge: { available: true } });
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    expect(screen.queryByRole('region', { name: 'Pull request' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close without merging' })).toBeNull();
  });

  it.each([
    ['not_configured', 'Merge credential is not configured'],
    ['unsupported_host', 'Git host is not supported'],
  ] as const)('says why it is off when merging is unavailable (%s)', async (reason, words) => {
    const run = delivered({ merge: { available: false, reason } });
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    expect(closeButton()).toBeNull();
    expect(within(card()).getByText(new RegExp(words))).toBeTruthy();
  });

  it('confirms what happens, and closes nothing when kept', async () => {
    const run = delivered();
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    await userEvent.click(closeButton()!);
    const dialog = await screen.findByRole('alertdialog', { name: 'Close without merging' });

    expect(
      within(dialog).getByText(/pull request is closed on GitHub without merging/),
    ).toBeTruthy();
    expect(within(dialog).getByText(/Run branch is deleted on GitHub/)).toBeTruthy();
    expect(within(dialog).getByText('The run takes no more Follow-ups.')).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: 'Close without merging' }).dataset.variant,
    ).toBe('destructive');
    await expect(document.body).toHaveNoAxeViolations();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep pull request' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.calls('closePullRequest')).toHaveLength(0);
  });

  it('closes on confirm, and the page shows the pull request closed from Studio', async () => {
    const run = delivered();
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    await userEvent.click(closeButton()!);
    const dialog = await screen.findByRole('alertdialog', { name: 'Close without merging' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close without merging' }));

    expect(await screen.findByText('Closed from Studio')).toBeTruthy();
    expect(api.calls('closePullRequest')).toHaveLength(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(card().textContent).toContain('The Run branch was deleted');
    expect(closeButton()).toBeNull();
    expect(within(card()).getByText('Closed')).toBeTruthy();
  });

  it('shows what is left when the branch deletion failed, and retries only that', async () => {
    const closedAt = '2026-11-21T12:00:00.000Z';
    const run = delivered({
      pullRequest: {
        ...PULL_REQUEST,
        state: 'closed',
        closedFromStudioAt: closedAt,
        runBranchDeletionFailure: 'Branch is protected.',
      },
    });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    expect(within(card()).getByText('Closed from Studio')).toBeTruthy();
    expect(within(card()).getByText(/Run branch is still on GitHub/)).toBeTruthy();
    expect(within(card()).getByText('Branch is protected.')).toBeTruthy();
    expect(closeButton()).toBeNull();

    api.respondNext('closePullRequest', 200, {
      state: 'closed',
      closedFromStudioAt: closedAt,
      runBranchDeletedAt: closedAt,
    });
    api.update(run.id, {
      pullRequest: {
        ...run.pullRequest!,
        runBranchDeletionFailure: undefined,
        runBranchDeletedAt: closedAt,
      },
    });
    await userEvent.click(
      within(card()).getByRole('button', { name: 'Delete the Run branch again' }),
    );

    expect(await within(card()).findByText(/The Run branch was deleted/)).toBeTruthy();
    expect(api.calls('closePullRequest')).toHaveLength(1);
    expect(
      within(card()).queryByRole('button', { name: 'Delete the Run branch again' }),
    ).toBeNull();
  });

  it('offers the retry when the deletion never finished and left no reason', async () => {
    const run = delivered({
      pullRequest: {
        ...PULL_REQUEST,
        state: 'closed',
        closedFromStudioAt: '2026-11-21T12:00:00.000Z',
      },
    });
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    expect(within(card()).getByText('Deleting it did not finish.')).toBeTruthy();
    expect(
      within(card()).getByRole('button', { name: 'Delete the Run branch again' }),
    ).toBeTruthy();
  });

  it('says why the retry is not offered when merging became unavailable', async () => {
    const run = delivered({
      merge: { available: false, reason: 'not_configured' },
      pullRequest: {
        ...PULL_REQUEST,
        state: 'closed',
        closedFromStudioAt: '2026-11-21T12:00:00.000Z',
        runBranchDeletionFailure: 'Branch is protected.',
      },
    });
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    expect(
      within(card()).queryByRole('button', { name: 'Delete the Run branch again' }),
    ).toBeNull();
    expect(
      within(card()).getByText(/Deleting it from Studio is off: .*Merge credential/),
    ).toBeTruthy();
  });

  it('keeps a refusal in the dialog, with the reason', async () => {
    const run = delivered();
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();
    api.respondNext(
      'closePullRequest',
      409,
      problem(409, 'The Git host refused', 'GitHub refused: Resource not accessible.'),
    );

    await userEvent.click(closeButton()!);
    const dialog = await screen.findByRole('alertdialog', { name: 'Close without merging' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close without merging' }));

    expect(
      await within(dialog).findByText('GitHub refused: Resource not accessible.'),
    ).toBeTruthy();
    expect(screen.queryByText('Closed from Studio')).toBeNull();
  });
});
