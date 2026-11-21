import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunDetail } from '..';
import { aRun, type FakeMergeReview, fakeRunsApi, problem } from './fake-runs-api';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  act(() => focusManager.setFocused(undefined));
});

const PULL_REQUEST = {
  url: 'https://github.com/acme/shop/pull/7',
  number: 7,
  state: 'open',
} as const;
const RUN_COMMIT = 'b'.repeat(40);
const INTEGRATION_COMMIT = 'a'.repeat(40);

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,2 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '',
].join('\n');

const READY: FakeMergeReview = {
  state: 'ready',
  runCommit: RUN_COMMIT,
  integrationCommit: INTEGRATION_COMMIT,
  truncated: false,
  files: [
    { path: 'src/app.ts', status: 'modified', cut: false, patch: PATCH },
    { path: 'logo.png', status: 'added', binary: true, cut: false },
    { path: 'data.json', status: 'added', cut: true },
  ],
};

async function openReview(
  runOverrides = {},
  review?: FakeMergeReview,
): Promise<{ api: ReturnType<typeof fakeRunsApi>; user: ReturnType<typeof userEvent.setup> }> {
  const run = aRun({ state: 'succeeded', pullRequest: PULL_REQUEST, ...runOverrides });
  const api = fakeRunsApi([run]);
  if (review) api.setMergeReview(run.id, review);
  const user = userEvent.setup();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RunDetail runId={run.id} />
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { level: 1 });
  await user.click(screen.getByRole('tab', { name: 'Changes' }));
  return { api, user };
}

const reviewSection = () =>
  screen.getByRole('region', { name: 'Merge review, computed by Studio' });

describe('Run page: merge review', () => {
  it('names the two sources of the changes apart', async () => {
    await openReview();

    expect(
      await screen.findByRole('heading', { name: 'Merge review, computed by Studio' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'Run diff, reported by the agent worker' }),
    ).toBeTruthy();
  });

  it('shows no merge review for a Run without a pull request', async () => {
    await openReview({ pullRequest: undefined });

    expect(
      await screen.findByRole('heading', { name: 'Run diff, reported by the agent worker' }),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Merge review, computed by Studio' })).toBeNull();
  });

  it('offers a review before one was requested, and requests it on the button', async () => {
    const { api, user } = await openReview();

    await user.click(await screen.findByRole('button', { name: 'Review for merge' }));

    expect(api.calls('requestMergeReview')).toHaveLength(1);
    expect(await within(reviewSection()).findByText(/Preparing the review/)).toBeTruthy();
  });

  it('says a review is being prepared, and keeps the button busy', async () => {
    await openReview({}, { state: 'preparing', files: [], truncated: false });

    const section = reviewSection();
    expect(await within(section).findByText(/Preparing the review/)).toBeTruthy();
    expect(
      within(section).getByRole('button', { name: 'Review again' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('shows why a review failed and offers another', async () => {
    await openReview(
      {},
      {
        state: 'failed',
        files: [],
        truncated: false,
        failure: 'The Run branch conflicts with the Integration branch.',
      },
    );

    const section = reviewSection();
    expect(
      await within(section).findByText('The Run branch conflicts with the Integration branch.'),
    ).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Review again' })).toBeTruthy();
  });

  it('lists a ready review’s files and shows a file’s patch as a diff, reusing the Run diff view', async () => {
    const { user } = await openReview({}, READY);

    const files = await within(reviewSection()).findByRole('navigation', { name: 'Changed files' });
    expect(
      within(files)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['src/app.tsModified,', 'logo.pngAdded,', 'data.jsonAdded,']);
    expect(within(reviewSection()).getByText('3 files would change')).toBeTruthy();
    expect(within(reviewSection()).getByText(RUN_COMMIT.slice(0, 12))).toBeTruthy();
    const diff = await within(
      within(reviewSection()).getByRole('region', { name: 'src/app.ts' }),
    ).findByRole('region', { name: 'Diff of src/app.ts' });
    expect(within(diff).getByText('const b = 3;')).toBeTruthy();
    await user.click(within(files).getByRole('button', { name: /logo\.png/ }));
    expect(await within(reviewSection()).findByText(/Binary file/)).toBeTruthy();
  });

  it('says a file whose patch a limit left out is too large', async () => {
    await openReview({}, READY);

    expect(
      await within(reviewSection()).findByText(
        'Too large to show: its changes are over the size limit.',
      ),
    ).toBeTruthy();
  });

  it('warns that the Run branch moved on since an out-of-date review', async () => {
    await openReview({}, { ...READY, state: 'out_of_date' });

    expect(
      await within(reviewSection()).findByText('The Run branch moved on since this review.'),
    ).toBeTruthy();
    expect(within(reviewSection()).getByRole('button', { name: 'Review again' })).toBeTruthy();
  });

  it('says when the review is cut by a limit', async () => {
    await openReview({}, { ...READY, truncated: true });

    expect(await within(reviewSection()).findByText('Not every change is shown.')).toBeTruthy();
  });

  it('shows the API’s reason when a review is refused', async () => {
    const { api, user } = await openReview();
    api.respondNext(
      'requestMergeReview',
      409,
      problem(409, 'Review in progress', 'A review of this run is already being prepared.'),
    );

    await user.click(await screen.findByRole('button', { name: 'Review for merge' }));

    expect(
      await within(reviewSection()).findByText('A review of this run is already being prepared.'),
    ).toBeTruthy();
  });

  it('offers no review for a pull request that is merged, closed or gone', async () => {
    await openReview({ pullRequest: { ...PULL_REQUEST, state: 'merged' } });

    const section = reviewSection();
    expect(await within(section).findByText(/The pull request is merged/)).toBeTruthy();
    expect(
      within(section).getByRole('button', { name: 'Review for merge' }).hasAttribute('disabled'),
    ).toBe(true);
  });
});
