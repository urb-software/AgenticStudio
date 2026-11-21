import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RunDetail } from '..';
import type { MergeApprovalOutput, RunOutput } from '../../../platform/api';
import { aRun, type FakeMergeReview, fakeRunsApi, PROJECT, problem } from './fake-runs-api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
const COMMIT = 'b'.repeat(40);
const MERGED_COMMIT = 'f'.repeat(40);

const READY: FakeMergeReview = {
  state: 'ready',
  runCommit: COMMIT,
  integrationCommit: 'a'.repeat(40),
  truncated: false,
  files: [{ path: 'src/app.ts', status: 'modified', cut: false }],
};

const APPROVAL: MergeApprovalOutput = {
  id: '00000000-0000-4000-8000-0000000000e1',
  approvedAt: '2026-11-21T12:00:00.000Z',
  approvedBy: 'operator',
  commit: COMMIT,
  integrationBranch: 'dev',
  method: 'squash',
  checksSeen: [],
  result: 'carried_out',
  mergedCommit: MERGED_COMMIT,
  completedAt: '2026-11-21T12:00:03.000Z',
};

function renderRun(runId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RunDetail runId={runId} />
    </QueryClientProvider>,
  );
}

const card = () => screen.getByRole('region', { name: 'Pull request' });
const reviewSection = () =>
  screen.getByRole('region', { name: 'Merge review, computed by Studio' });
const mergeButton = () => screen.queryByRole('button', { name: 'Approve and merge' });

/** A finished Run with a draft pull request, when Studio can merge, and its checks as last read. */
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
      checks: [
        { name: 'build', state: 'passed', url: 'https://github.com/acme/shop/runs/1' },
        { name: 'lint', state: 'skipped', url: 'https://github.com/acme/shop/runs/2' },
      ],
      checksCommit: COMMIT,
    },
    steps: { used: 1, usedInPart: 1 },
    merge: { available: true },
    integrationBranch: 'dev',
    ...overrides,
  });
}

async function openChanges(run: RunOutput, review: FakeMergeReview | null = READY) {
  const api = fakeRunsApi([run]);
  if (review) api.setMergeReview(run.id, review);
  renderRun(run.id);
  await screen.findByRole('heading', { level: 1 });
  await userEvent.click(screen.getByRole('tab', { name: 'Changes' }));
  await within(reviewSection()).findByRole('button', { name: /Review again|Review for merge/ });
  return api;
}

describe('Run page: Approve and merge', () => {
  it('is offered for a finished Run whose merge review is ready and up to date', async () => {
    await openChanges(delivered());

    expect(await within(reviewSection()).findByRole('button', { name: 'Approve and merge' })).toBe(
      mergeButton(),
    );
    expect(mergeButton()?.dataset.variant).toBe('primary');
  });

  it.each([
    ['no merge review', null, {}],
    [
      'a review that is preparing',
      { state: 'preparing' as const, files: [], truncated: false },
      {},
    ],
    ['a review that is out of date', { ...READY, state: 'out_of_date' as const }, {}],
    ['a review that failed', { state: 'failed' as const, files: [], truncated: false }, {}],
    ['a Run that is still working', READY, { state: 'running' as const, finishedAt: undefined }],
    [
      'a merged pull request',
      READY,
      { pullRequest: { ...PULL_REQUEST, state: 'merged' as const } },
    ],
    [
      'a merge that is already carried out',
      READY,
      { latestMergeApproval: APPROVAL, pullRequest: { ...PULL_REQUEST, state: 'draft' as const } },
    ],
  ])('is not offered for %s', async (_name, review, overrides) => {
    await openChanges(delivered(overrides), review);

    expect(mergeButton()).toBeNull();
  });

  it.each([
    ['not_configured', 'Merge credential is not configured'],
    ['unsupported_host', 'Git host is not supported'],
  ] as const)('says why it is off when merging is unavailable (%s)', async (reason, words) => {
    await openChanges(delivered({ merge: { available: false, reason } }));

    expect(mergeButton()).toBeNull();
    expect(within(reviewSection()).getByText(new RegExp(words))).toBeTruthy();
  });

  it('confirms the short commit, the Integration branch, the method and the checks the page last saw, and merges nothing when kept', async () => {
    const api = await openChanges(delivered());

    await userEvent.click(mergeButton()!);
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve and merge' });

    expect(within(dialog).getByText(COMMIT.slice(0, 12))).toBeTruthy();
    expect(within(dialog).getByText('dev')).toBeTruthy();
    expect(within(dialog).getByText('Squash')).toBeTruthy();
    expect(within(dialog).getByText('build: passed')).toBeTruthy();
    expect(within(dialog).getByText('lint: skipped')).toBeTruthy();
    await expect(document.body).toHaveNoAxeViolations();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Not yet' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.calls('mergeRun')).toHaveLength(0);
  });

  it("names the merge commit method when the Project's setting says so", async () => {
    const run = delivered();
    const api = fakeRunsApi([run]);
    api.setMergeReview(run.id, READY);
    // The page reads the Project when it opens and the dialog reads it again when it mounts.
    for (let reads = 0; reads < 3; reads++) {
      api.respondNext('project', 200, {
        ...PROJECT,
        mergeMethod: 'merge_commit',
        repository: null,
      });
    }
    renderRun(run.id);
    await screen.findByRole('heading', { level: 1 });
    await userEvent.click(screen.getByRole('tab', { name: 'Changes' }));
    await userEvent.click(
      await within(reviewSection()).findByRole('button', { name: 'Approve and merge' }),
    );

    const dialog = await screen.findByRole('alertdialog', { name: 'Approve and merge' });

    expect(within(dialog).getByText('Merge commit')).toBeTruthy();
    expect(within(dialog).queryByText('Squash')).toBeNull();
  });

  it.each([
    ['squash', 'squash'],
    ['merge_commit', 'merge commit'],
  ] as const)('shows the method %s the Merge approval recorded', async (method, words) => {
    await openChanges(
      delivered({
        latestMergeApproval: { ...APPROVAL, method },
        pullRequest: { ...PULL_REQUEST, state: 'merged', runBranchDeletedAt: APPROVAL.completedAt },
      }),
    );

    expect(card().textContent).toContain(`, ${words}, into`);
  });

  it('merges the reviewed commit on confirm, and the page shows who merged, when and at which commit', async () => {
    const api = await openChanges(delivered());

    await userEvent.click(mergeButton()!);
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve and merge' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve and merge' }));

    expect(await screen.findByText('Merged from Studio')).toBeTruthy();
    expect(api.calls('mergeRun')).toEqual([expect.objectContaining({ body: { commit: COMMIT } })]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(card().textContent).toContain('by the operator');
    expect(card().textContent).toContain(`as commit ${MERGED_COMMIT.slice(0, 12)}`);
    expect(card().textContent).toContain('The Run branch was deleted');
    expect(within(card()).getByText('Merged')).toBeTruthy();
    expect(mergeButton()).toBeNull();
  });

  it('keeps a refusal in the dialog, with its reason', async () => {
    const api = await openChanges(delivered());
    api.respondNext(
      'mergeRun',
      409,
      problem(409, 'A check is failing', 'A check of the pull request is failing.'),
    );

    await userEvent.click(mergeButton()!);
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve and merge' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve and merge' }));

    expect(await within(dialog).findByText('A check of the pull request is failing.')).toBeTruthy();
    expect(screen.queryByText('Merged from Studio')).toBeNull();
  });

  it('shows a merge the Git host refused after the approval, with the reason', async () => {
    const run = delivered({
      latestMergeApproval: {
        ...APPROVAL,
        result: 'not_carried_out',
        mergedCommit: undefined,
        refusal: { code: 'host_refused', reason: 'Required status check is expected.' },
      },
    });
    await openChanges(run);

    expect(within(card()).getByText('The last merge was not carried out.')).toBeTruthy();
    expect(within(card()).getByText(/Required status check is expected\./)).toBeTruthy();
    expect(mergeButton()).toBeTruthy();
  });

  const UNKNOWN: MergeApprovalOutput = {
    ...APPROVAL,
    result: 'not_carried_out',
    mergedCommit: undefined,
    mergeOutcomeUnknown: true,
    refusal: {
      code: 'interrupted',
      reason: 'GitHub could not be reached. The merge may have gone through.',
    },
  };

  it('offers to record a merge that may have gone through unseen, and shows the record afterwards', async () => {
    const api = await openChanges(
      delivered({
        pullRequest: { ...PULL_REQUEST, state: 'merged' },
        latestMergeApproval: UNKNOWN,
      }),
    );

    expect(within(card()).getByText(/GitHub did not answer the merge/)).toBeTruthy();
    await userEvent.click(within(card()).getByRole('button', { name: 'Record the merge' }));

    expect(await within(card()).findByText('Merged from Studio')).toBeTruthy();
    expect(api.calls('mergeRun')).toEqual([expect.objectContaining({ body: { commit: COMMIT } })]);
  });

  it('shows why when the request to record the merge is refused', async () => {
    const api = await openChanges(
      delivered({
        pullRequest: { ...PULL_REQUEST, state: 'merged' },
        latestMergeApproval: UNKNOWN,
      }),
    );
    api.respondNext(
      'mergeRun',
      409,
      problem(409, 'The pull request is not open', 'The pull request is merged, closed or gone.'),
    );

    await userEvent.click(within(card()).getByRole('button', { name: 'Record the merge' }));

    expect(
      await within(card()).findByText('The pull request is merged, closed or gone.'),
    ).toBeTruthy();
    expect(within(card()).queryByText('Merged from Studio')).toBeNull();
  });

  it('offers the normal approval, not a recording, while the pull request is still open', async () => {
    await openChanges(delivered({ latestMergeApproval: UNKNOWN }));

    expect(within(card()).queryByRole('button', { name: 'Record the merge' })).toBeNull();
    expect(mergeButton()).toBeTruthy();
  });

  it('offers no recording for a merge that was refused or never reached the host', async () => {
    await openChanges(
      delivered({
        pullRequest: { ...PULL_REQUEST, state: 'merged' },
        latestMergeApproval: {
          ...UNKNOWN,
          mergeOutcomeUnknown: undefined,
          refusal: { code: 'host_refused', reason: 'Required status check is expected.' },
        },
      }),
    );

    expect(within(card()).getByText('The last merge was not carried out.')).toBeTruthy();
    expect(within(card()).queryByRole('button', { name: 'Record the merge' })).toBeNull();
  });

  it('says a merge is under way while the approval is pending', async () => {
    await openChanges(delivered({ latestMergeApproval: { ...APPROVAL, result: 'pending' } }));

    expect(within(card()).getByText(/A merge is under way/)).toBeTruthy();
    expect(mergeButton()).toBeNull();
  });

  describe('after a merge', () => {
    const merged = (overrides: Partial<RunOutput> = {}) =>
      delivered({
        pullRequest: {
          ...PULL_REQUEST,
          state: 'merged',
          runBranchDeletedAt: '2026-11-21T12:00:04.000Z',
        },
        latestMergeApproval: { ...APPROVAL, cloneFetchStartedAt: '2026-11-21T12:00:05.000Z' },
        ...overrides,
      });

    it('points to the Repository for how the fetch ended when nothing is left', async () => {
      await openChanges(merged());

      expect(within(card()).getByText('Merged from Studio')).toBeTruthy();
      const link = within(card()).getByRole('link', { name: 'Repository' });
      expect(link.getAttribute('href')).toMatch(/^\/projects\//);
      expect(within(card()).queryByRole('button', { name: 'Finish the missing steps' })).toBeNull();
    });

    it('says what is left when the branch deletion failed, and retries through the same request', async () => {
      const run = merged({
        pullRequest: {
          ...PULL_REQUEST,
          state: 'merged',
          runBranchDeletionFailure: 'Branch is protected.',
        },
      });
      const api = await openChanges(run);

      expect(within(card()).getByText(/The Run branch is still on GitHub/)).toBeTruthy();
      expect(within(card()).getByText(/Branch is protected\./)).toBeTruthy();
      await userEvent.click(
        within(card()).getByRole('button', { name: 'Finish the missing steps' }),
      );

      expect(await within(card()).findByText(/The Run branch was deleted/)).toBeTruthy();
      expect(api.calls('mergeRun')).toEqual([
        expect.objectContaining({ body: { commit: COMMIT } }),
      ]);
      expect(within(card()).queryByRole('button', { name: 'Finish the missing steps' })).toBeNull();
    });

    it('offers the retry while the Clone fetch has not started', async () => {
      await openChanges(
        merged({ latestMergeApproval: { ...APPROVAL, cloneFetchStartedAt: undefined } }),
      );

      expect(within(card()).getByText(/has not been told to fetch the merge yet/)).toBeTruthy();
      expect(within(card()).getByRole('button', { name: 'Finish the missing steps' })).toBeTruthy();
    });

    it('says why the retry is not offered when merging became unavailable', async () => {
      await openChanges(
        merged({
          merge: { available: false, reason: 'not_configured' },
          latestMergeApproval: { ...APPROVAL, cloneFetchStartedAt: undefined },
        }),
      );

      expect(within(card()).queryByRole('button', { name: 'Finish the missing steps' })).toBeNull();
      expect(
        within(card()).getByText(/Finishing them from Studio is off: .*Merge credential/),
      ).toBeTruthy();
    });
  });
});
