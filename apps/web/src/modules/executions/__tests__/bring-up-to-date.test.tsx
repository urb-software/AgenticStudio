import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RunDetail } from '..';
import type { RunOutput } from '../../../platform/api';
import { aRun, fakeRunsApi, problem } from './fake-runs-api';

// Issue #147 on the Run page seam: the "Bring up to date" action of the pull request card, its
// confirm, and how the conversation shows such a Follow-up, with the generated client, the API
// wrapper and TanStack Query real, and the API faked at `fetch`.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
const MERGED = 'e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0';

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

/** A delivered Run whose pull request is behind the integration branch. */
function behind(
  pullRequest: Partial<NonNullable<RunOutput['pullRequest']>> = {},
  overrides: Partial<RunOutput> = {},
): RunOutput {
  return aRun({
    task: 'Add a health check',
    state: 'succeeded',
    startedAt: '2026-11-16T11:00:01.000Z',
    finishedAt: '2026-11-16T11:05:00.000Z',
    runBranch: 'agent/add-a-health-check-r1',
    delivery: 'delivered',
    pullRequest: {
      ...PULL_REQUEST,
      state: 'open',
      behindBy: 3,
      aheadBy: 1,
      mergeable: false,
      refreshedAt: '2026-11-16T12:00:00.000Z',
      ...pullRequest,
    },
    steps: { used: 1, usedInPart: 1 },
    followUp: { allowed: true },
    ...overrides,
  });
}

describe('Run page: Bring up to date (Issue #147)', () => {
  it('offers the action with how far behind the branch is and whether GitHub reports conflicts', async () => {
    const run = behind();
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    const offer = within(card()).getByText(/behind the integration branch/);
    expect(offer.textContent).toContain('3 commits behind');
    expect(offer.textContent).toContain('GitHub reports conflicts');
    expect(within(card()).getByRole('button', { name: 'Bring up to date' })).toBeTruthy();
  });

  it.each([
    ['no conflicts', { mergeable: true }, 'GitHub reports no conflicts.'],
    [
      'an unknown verdict',
      { mergeable: undefined },
      'GitHub has not said whether there are conflicts.',
    ],
  ])('says so when GitHub reports %s', async (_name, pullRequest, words) => {
    const run = behind(pullRequest);
    fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    expect(within(card()).getByText(/behind the integration branch/).textContent).toContain(words);
  });

  it('is not offered when the branch is not behind, or the Run cannot take a Follow-up', async () => {
    const upToDate = behind({ behindBy: 0 });
    const blocked = behind({}, { followUp: { allowed: false, reason: 'worker_unavailable' } });
    const unknown = behind({ behindBy: undefined, aheadBy: undefined });
    for (const run of [upToDate, blocked, unknown]) {
      fakeRunsApi([run]);
      const { unmount } = renderRun(run.id);
      await heading();
      expect(within(card()).queryByRole('button', { name: 'Bring up to date' })).toBeNull();
      unmount();
    }
  });

  it('explains what will happen and sends the optional note on confirm', async () => {
    const run = behind();
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    await userEvent.click(within(card()).getByRole('button', { name: 'Bring up to date' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bring up to date' });
    const text = dialog.textContent ?? '';
    expect(text).toContain('committed first');
    expect(text).toContain('never rebases and never force-pushes');
    expect(text).toContain('resolves them, completes the merge and runs the checks');
    expect(text).toContain('same pull request');
    expect(text).toContain('merge is aborted, nothing is pushed');
    expect(api.calls('bringUp')).toHaveLength(0);

    await userEvent.type(within(dialog).getByLabelText(/Note for the agent/), '  Prefer main.  ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Bring up to date' }));

    expect(await screen.findByText('Update requested.')).toBeTruthy();
    expect(api.calls('bringUp')[0]?.body).toEqual({ note: 'Prefer main.' });
    expect(screen.queryByRole('dialog')).toBeNull();
    const conversation = screen.getByRole('list', { name: 'Conversation' });
    expect(conversation.textContent).toContain('You · Follow-up 1 · Bring up to date');
    expect(conversation.textContent).toContain('Prefer main.');
  });

  it('does not bring the confirm back when the Run is finished again after the update', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const run = behind();
      const api = fakeRunsApi([run]);
      renderRun(run.id);
      await heading();
      await userEvent.click(within(card()).getByRole('button', { name: 'Bring up to date' }));
      const dialog = await screen.findByRole('dialog', { name: 'Bring up to date' });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Bring up to date' }));
      expect(await screen.findByText('Update requested.')).toBeTruthy();

      // The worker merged, delivered and finished: the Run is final again, still read as behind.
      api.update(run.id, {
        state: 'succeeded',
        followUp: { allowed: true },
        finishedAt: '2026-11-16T12:40:00.000Z',
      });
      await act(() => vi.advanceTimersByTimeAsync(2_100));

      expect(await within(card()).findByRole('button', { name: 'Bring up to date' })).toBeTruthy();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('list', { name: 'Conversation' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends no note when there is none, and the conversation says so', async () => {
    const run = behind();
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    await userEvent.click(within(card()).getByRole('button', { name: 'Bring up to date' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bring up to date' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Bring up to date' }));

    expect(await screen.findByText('Update requested.')).toBeTruthy();
    expect(api.calls('bringUp')[0]?.body).toEqual({});
    expect(screen.getByRole('list', { name: 'Conversation' }).textContent).toContain('No note.');
  });

  it('can be dismissed without asking anything', async () => {
    const run = behind();
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await heading();

    await userEvent.click(within(card()).getByRole('button', { name: 'Bring up to date' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bring up to date' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.calls('bringUp')).toHaveLength(0);
  });

  it("checks the note's length, shows the server's field error and a refusal as a banner", async () => {
    const run = behind();
    const api = fakeRunsApi([run]);
    api.respondNext(
      'bringUp',
      422,
      problem(422, 'Unprocessable Entity', 'The request is invalid.', [
        { path: 'note', message: 'Use at most 10000 characters.' },
      ]),
    );
    api.respondNext(
      'bringUp',
      409,
      problem(409, 'Follow-up not possible', 'A Follow-up is already queued for this run.'),
    );
    renderRun(run.id);
    await heading();
    await userEvent.click(within(card()).getByRole('button', { name: 'Bring up to date' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bring up to date' });

    await userEvent.click(within(dialog).getByLabelText(/Note for the agent/));
    await userEvent.paste('a'.repeat(10_001));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Bring up to date' }));
    expect(within(dialog).getByText('Use at most 10000 characters.')).toBeTruthy();
    expect(api.calls('bringUp')).toHaveLength(0);

    // The server's own answer (a shorter note it still refuses) lands on the field.
    await userEvent.clear(within(dialog).getByLabelText(/Note for the agent/));
    await userEvent.type(within(dialog).getByLabelText(/Note for the agent/), 'ok');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Bring up to date' }));
    expect(await within(dialog).findByText('Use at most 10000 characters.')).toBeTruthy();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Bring up to date' }));
    expect(await within(dialog).findByText('Follow-up not possible')).toBeTruthy();
    expect(within(dialog).getByText('A Follow-up is already queued for this run.')).toBeTruthy();
  });

  it('has no accessibility violations: the card with the action, and the open confirm', async () => {
    const run = behind();
    fakeRunsApi([run]);
    const { container } = renderRun(run.id);
    await heading();
    await expect(container).toHaveNoAxeViolations();

    await userEvent.click(within(card()).getByRole('button', { name: 'Bring up to date' }));
    await screen.findByRole('dialog', { name: 'Bring up to date' });
    await expect(document.body).toHaveNoAxeViolations();
  });

  describe('the conversation', () => {
    const entry = (extra: object = {}) => ({
      role: 'operator' as const,
      kind: 'follow_up' as const,
      text: 'Keep our config.',
      source: 'bring_up_to_date' as const,
      at: '2026-11-16T12:30:00.000Z',
      ...extra,
    });
    const partEnd = {
      role: 'studio' as const,
      kind: 'part_end' as const,
      text: '',
      end: { state: 'succeeded' as const, delivery: 'delivered' as const },
      at: '2026-11-16T12:29:00.000Z',
    };

    it('marks the Follow-up as bringing the branch up to date, with the note and the merged commit', async () => {
      const base = behind();
      const run = {
        ...base,
        followUps: 1,
        messages: [...(base.messages ?? []), partEnd, entry({ mergedCommit: MERGED })],
      };
      fakeRunsApi([run]);
      renderRun(run.id);
      await heading();

      const conversation = screen.getByRole('list', { name: 'Conversation' });
      expect(conversation.textContent).toContain('You · Follow-up 1 · Bring up to date');
      expect(conversation.textContent).toContain('Keep our config.');
      const commit = within(conversation).getByText(MERGED.slice(0, 7));
      expect(commit.getAttribute('title')).toBe(MERGED);
      expect(conversation.textContent).toContain('Merged the integration branch commit');
    });

    it('shows a branch that was already up to date as the part ending unchanged', async () => {
      const base = behind();
      const run = {
        ...base,
        followUps: 1,
        messages: [
          ...(base.messages ?? []),
          partEnd,
          entry({ text: '' }),
          {
            ...partEnd,
            text: 'The Run branch already has everything dev has, so nothing was changed: no agent was started and nothing was pushed.',
            at: '2026-11-16T12:31:00.000Z',
          },
        ],
      };
      fakeRunsApi([run]);
      renderRun(run.id);
      await heading();

      const conversation = screen.getByRole('list', { name: 'Conversation' });
      expect(conversation.textContent).toContain('No note.');
      expect(conversation.textContent).toContain('already has everything dev has');
      expect(conversation.textContent).not.toContain('Merged the integration branch commit');
    });
  });
});
