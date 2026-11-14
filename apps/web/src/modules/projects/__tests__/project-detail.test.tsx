import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster, toast } from '@/shared/ui/sonner';
import { ProjectDetail } from '..';
import type { ProjectOutput, RepositoryOutput } from '../../../platform/api';
import {
  FAKE_FINGERPRINT,
  FAKE_PUBLIC_KEY,
  fakeProjectApi,
  fieldProblem,
} from './fake-project-api';
import { problem } from './fake-projects-api';

// Project screen seam (Stories #60, #61, #62 and #63): the public ProjectDetail of the projects module, with the
// generated client, the API wrapper and TanStack Query real, and the API faked at `fetch`.

const PROJECT: ProjectOutput = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Acme Shop',
  createdAt: '2026-11-12T09:00:00.000Z',
};
const URL = 'https://github.com/acme/shop.git';
const SHA = '0123456789abcdef0123456789abcdef01234567';

const CONNECTING: RepositoryOutput = {
  state: 'connecting',
  url: URL,
  integrationBranch: 'dev',
  hasClone: false,
};
const READY: RepositoryOutput = {
  state: 'ready',
  url: URL,
  integrationBranch: 'dev',
  hasClone: true,
  headSha: SHA,
  lastFetchedAt: '2026-11-13T10:00:00.000Z',
};
const failed = (
  failure: RepositoryOutput['failure'],
  integrationBranch = 'dev',
): RepositoryOutput => ({
  state: 'failed',
  url: URL,
  integrationBranch,
  hasClone: false,
  failure,
});

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectDetail projectId={PROJECT.id} />
      <Toaster />
    </QueryClientProvider>,
  );
}

/** Renders the screen and waits until the project (and so its Repository card) is shown. */
async function renderLoaded() {
  const view = renderDetail();
  await screen.findByRole('region', { name: 'Repository' });
  return view;
}

const card = () => screen.getByRole('region', { name: 'Repository' });
const dialog = () => screen.getByRole('dialog', { name: 'Connect repository' });
const urlInput = () => within(dialog()).getByLabelText<HTMLInputElement>('Repository URL');
const branchInput = () => within(dialog()).getByLabelText<HTMLInputElement>('Integration branch');

async function openDialog() {
  await userEvent.click(await within(card()).findByRole('button', { name: 'Connect repository' }));
  return dialog();
}

async function submit(url: string, branch?: string) {
  await userEvent.clear(urlInput());
  if (url) await userEvent.type(urlInput(), url);
  if (branch !== undefined) {
    await userEvent.clear(branchInput());
    if (branch) await userEvent.type(branchInput(), branch);
  }
  await userEvent.click(within(dialog()).getByRole('button', { name: 'Connect repository' }));
}

async function expectFieldError(input: HTMLInputElement, message: string) {
  const error = await within(dialog()).findByText(message);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(input.getAttribute('aria-describedby')).toContain(error.id);
}

afterEach(() => {
  act(() => {
    focusManager.setFocused(undefined);
    toast.dismiss();
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('project screen', () => {
  it('shows the name, the creation time and an empty Repository card with Connect', async () => {
    fakeProjectApi(PROJECT);
    const { container } = renderDetail();

    expect(await screen.findByRole('heading', { level: 1, name: 'Acme Shop' })).toBeTruthy();
    expect(
      screen
        .getByText(/^Created/)
        .querySelector('time')
        ?.getAttribute('dateTime'),
    ).toBe(PROJECT.createdAt);
    expect(within(card()).getByRole('heading', { name: 'No repository connected' })).toBeTruthy();
    expect(within(card()).getByRole('button', { name: 'Connect repository' }).dataset.variant).toBe(
      'primary',
    );
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows a not-found state that links back to Projects for an unknown project', async () => {
    const api = fakeProjectApi(PROJECT);
    api.respondNext('project', 404, problem(404, 'Project not found'));
    const { container } = renderDetail();

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Projects' }).getAttribute('href')).toBe(
      '/projects',
    );
    await expect(container).toHaveNoAxeViolations();
  });
});

describe('Connect repository dialog', () => {
  it('asks for the Repository URL and the Integration branch, prefilled with dev', async () => {
    fakeProjectApi(PROJECT);
    await renderLoaded();

    await openDialog();

    expect(urlInput().value).toBe('');
    expect(branchInput().value).toBe('dev');
    await expect(dialog()).toHaveNoAxeViolations();
  });

  it.each([
    ['an empty URL', '', 'dev', 'url', 'Enter the repository URL.'],
    ['an empty integration branch', URL, '', 'branch', 'Enter the integration branch.'],
    ['an invalid branch name', URL, 'a..b', 'branch', 'Enter a valid branch name, e.g. dev.'],
  ] as const)('hints at %s without calling the API', async (_case, url, branch, field, message) => {
    const api = fakeProjectApi(PROJECT);
    await renderLoaded();
    await openDialog();

    await submit(url, branch);

    await expectFieldError(field === 'url' ? urlInput() : branchInput(), message);
    expect(api.calls('connect')).toEqual([]);
  });

  it('connects with the trimmed values, closes, and shows the clone in progress', async () => {
    const api = fakeProjectApi(PROJECT);
    const { container } = await renderLoaded();
    await openDialog();

    await submit(`  ${URL}  `, ' main ');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls('connect')).toEqual([
      { route: 'connect', body: { url: URL, integrationBranch: 'main' } },
    ]);
    expect(within(card()).getByText('Connecting')).toBeTruthy();
    expect(within(card()).getByRole('status').textContent).toMatch(/Cloning the repository/);
    expect(within(card()).getByText(URL).tagName).toBe('CODE');
    await expect(container).toHaveNoAxeViolations();
  });

  it.each([
    [
      'a git+ssh URL (422)',
      422,
      'Use git@host:owner/repo.git or ssh://git@host/owner/repo.git for SSH.',
    ],
    ['a remote connected to another project (409)', 409, 'Already connected to Other Project'],
  ])('shows the API field error for %s on the URL field', async (_case, status, message) => {
    const api = fakeProjectApi(PROJECT);
    api.respondNext(
      'connect',
      status,
      fieldProblem(status, 'Rejected', [{ path: 'url', message }]),
    );
    await renderLoaded();
    await openDialog();

    await submit('git@github.com:acme/shop.git');

    await expectFieldError(urlInput(), message);
    expect(dialog()).toBeTruthy();
    expect(within(dialog()).queryByRole('alert', { name: /Rejected/ })).toBeNull();
  });

  it('shows the API field error on the integration branch', async () => {
    const api = fakeProjectApi(PROJECT);
    api.respondNext(
      'connect',
      422,
      fieldProblem(422, 'Unprocessable Entity', [
        { path: 'integrationBranch', message: 'Enter a valid branch name, e.g. dev.' },
      ]),
    );
    await renderLoaded();
    await openDialog();

    await submit(URL, 'dev');

    await expectFieldError(branchInput(), 'Enter a valid branch name, e.g. dev.');
  });

  it('shows an unsupported-platform answer (501) as a banner in the dialog', async () => {
    const api = fakeProjectApi(PROJECT);
    api.respondNext('connect', 501, {
      ...problem(501, 'Unsupported platform'),
      type: 'urn:agentic-studio:problem:unsupported-platform',
      detail: 'Repository features run on Linux only.',
    });
    await renderLoaded();
    await openDialog();

    await submit(URL);

    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toContain('Unsupported platform');
    expect(alert.textContent).toContain('Repository features run on Linux only.');
    await expect(dialog()).toHaveNoAxeViolations();
  });
});

describe('Repository card states', () => {
  it('ready: shows the URL, the integration branch, the short commit in mono and Last fetched', async () => {
    fakeProjectApi(PROJECT, READY);
    const { container } = await renderLoaded();

    expect(await within(card()).findByText('Connected')).toBeTruthy();
    const commit = within(card()).getByText('0123456');
    expect(commit.tagName).toBe('CODE');
    expect(commit.getAttribute('title')).toBe(SHA);
    expect(within(card()).getByText('dev').tagName).toBe('CODE');
    expect(within(card()).getByText('Last fetched')).toBeTruthy();
    expect(card().querySelector('time')?.getAttribute('dateTime')).toBe(READY.lastFetchedAt);
    await expect(container).toHaveNoAxeViolations();
  });

  it.each([
    [
      'host_unreachable',
      undefined,
      'Studio could not reach the Git host. Check the URL and that the host is online.',
    ],
    ['repository_not_found', undefined, /The repository was not found/],
    [
      'branch_not_found',
      'main',
      'The branch "release" does not exist on the remote. Its default branch is "main".',
    ],
    ['timeout', undefined, 'The Git host took too long, so the clone was stopped.'],
    [
      'size_limit',
      undefined,
      'The repository is larger than the 2 GB limit, so Studio stopped and kept no clone.',
    ],
    [
      'remote_not_allowed',
      undefined,
      'Studio does not connect to this address: it is link-local, a cloud metadata service, or loopback or private without STUDIO_GIT_ALLOW_PRIVATE_REMOTES=true. The detail below names the address.',
    ],
    [
      'redirect_refused',
      undefined,
      'The Git host redirected Studio to another URL, and Studio does not follow redirects. Connect with the final URL of the repository.',
    ],
    ['unknown', undefined, 'The clone failed for an unexpected reason.'],
  ] as const)(
    'failed (%s): shows its message, the redacted detail in mono and Retry',
    async (code, remoteDefaultBranch, message) => {
      fakeProjectApi(
        PROJECT,
        failed(
          {
            code,
            detail: 'fatal: <redacted>',
            ...(remoteDefaultBranch ? { remoteDefaultBranch } : {}),
          },
          'release',
        ),
      );
      const { container } = await renderLoaded();

      const alert = await within(card()).findByRole('alert');
      expect(alert.textContent).toMatch(message);
      const detail = within(card()).getByLabelText('Git output');
      expect(detail.tagName).toBe('PRE');
      expect(detail.textContent).toBe('fatal: <redacted>');
      expect(within(card()).getByText('Failed')).toBeTruthy();
      expect(within(card()).getByRole('button', { name: 'Retry' })).toBeTruthy();
      await expect(container).toHaveNoAxeViolations();
    },
  );

  it.each([
    ['the interrupted code (#72)', { code: 'interrupted', detail: '' }],
    ['the detail an earlier API stored', { code: 'unknown', detail: 'Interrupted' }],
  ] as const)('failed after a crash (%s): says the clone was interrupted', async (_, failure) => {
    fakeProjectApi(PROJECT, failed(failure));
    await renderLoaded();

    expect((await within(card()).findByRole('alert')).textContent).toMatch(
      /The clone was interrupted/,
    );
  });

  it('Retry connects again with the stored URL and branch', async () => {
    const api = fakeProjectApi(PROJECT, failed({ code: 'timeout', detail: '' }, 'release'));
    await renderLoaded();

    await userEvent.click(await within(card()).findByRole('button', { name: 'Retry' }));

    await within(card()).findByText('Connecting');
    expect(api.calls('connect')).toEqual([
      { route: 'connect', body: { url: URL, integrationBranch: 'release' } },
    ]);
  });

  it('Change settings reopens Connect prefilled, so a missing branch can be fixed', async () => {
    const api = fakeProjectApi(
      PROJECT,
      failed({ code: 'branch_not_found', detail: '', remoteDefaultBranch: 'main' }, 'release'),
    );
    await renderLoaded();

    await userEvent.click(await within(card()).findByRole('button', { name: 'Change settings' }));

    expect(urlInput().value).toBe(URL);
    expect(branchInput().value).toBe('release');
    await submit(URL, 'main');
    await within(card()).findByText('Connecting');
    expect(api.calls('connect')).toEqual([
      { route: 'connect', body: { url: URL, integrationBranch: 'main' } },
    ]);
  });

  it('shows a Retry that the API refuses as a banner, with the problem title', async () => {
    const api = fakeProjectApi(PROJECT, failed({ code: 'timeout', detail: '' }));
    api.respondNext('connect', 409, problem(409, 'Clone already running'));
    await renderLoaded();

    await userEvent.click(await within(card()).findByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(
        within(card())
          .getAllByRole('alert')
          .map((alert) => alert.textContent),
      ).toContainEqual(expect.stringContaining('Clone already running')),
    );
  });

  it('a state this version does not know: shows the repository as unavailable', async () => {
    fakeProjectApi(PROJECT, {
      state: 'archived',
      url: URL,
      integrationBranch: 'dev',
    } as unknown as RepositoryOutput);
    const { container } = await renderLoaded();

    expect(await within(card()).findByText('Unavailable')).toBeTruthy();
    expect(within(card()).getByRole('status', { name: '' }).textContent).toMatch(/does not know/);
    await expect(container).toHaveNoAxeViolations();
  });
});

describe('polling while connecting (clarification 8)', () => {
  it('polls about every 2 s while connecting and stops when the Repository is ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeProjectApi(PROJECT, CONNECTING);
    await renderLoaded();
    await within(card()).findByText('Connecting');
    const before = api.calls('repository').length;

    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(api.calls('repository').length).toBe(before + 1);

    api.state.repository = READY;
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    await within(card()).findByText('Connected');
    const afterReady = api.calls('repository').length;

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.calls('repository').length).toBe(afterReady);
    // The project's summary is refreshed once the state changed.
    expect(api.calls('project').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps polling through a transient server error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeProjectApi(PROJECT, CONNECTING);
    await renderLoaded();
    await within(card()).findByText('Connecting');

    api.respondNext('repository', 503, problem(503, 'Service Unavailable'));
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    const afterError = api.calls('repository').length;
    api.state.repository = READY;
    await act(() => vi.advanceTimersByTimeAsync(2_100));

    expect(api.calls('repository').length).toBeGreaterThan(afterError);
    expect(await within(card()).findByText('Connected')).toBeTruthy();
  });

  it('stops when the clone failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeProjectApi(PROJECT, CONNECTING);
    await renderLoaded();
    await within(card()).findByText('Connecting');

    api.state.repository = failed({ code: 'host_unreachable', detail: '' });
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    await within(card()).findByText('Failed');
    const afterFailed = api.calls('repository').length;

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.calls('repository').length).toBe(afterFailed);
  });

  it('pauses while the tab is hidden and catches up when it is visible again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeProjectApi(PROJECT, CONNECTING);
    await renderLoaded();
    await within(card()).findByText('Connecting');

    act(() => focusManager.setFocused(false));
    const hidden = api.calls('repository').length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.calls('repository').length).toBe(hidden);

    api.state.repository = READY;
    act(() => focusManager.setFocused(true));
    expect(await within(card()).findByText('Connected')).toBeTruthy();
  });
});

describe('Fetch (Story #61)', () => {
  const NEW_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
  const fetchButton = () =>
    within(card()).getByRole<HTMLButtonElement>('button', { name: /^Fetch/ });
  const failedFetch = (
    failure: RepositoryOutput['failure'],
    integrationBranch = 'dev',
  ): RepositoryOutput => ({
    ...READY,
    integrationBranch,
    state: 'failed',
    failure,
  });

  it('ready: Fetch starts a fetch and the card shows it is fetching, with Fetch disabled', async () => {
    const api = fakeProjectApi(PROJECT, READY);
    const { container } = await renderLoaded();
    await within(card()).findByText('Connected');
    expect(fetchButton().disabled).toBe(false);

    await userEvent.click(fetchButton());

    expect(await within(card()).findByText('Fetching')).toBeTruthy();
    expect(api.calls('fetch')).toHaveLength(1);
    expect(within(card()).getByRole('status').textContent).toMatch(/Fetching dev/);
    expect(fetchButton().disabled).toBe(true);
    // The previous commit and fetch time stay visible while fetching.
    expect(within(card()).getByText('0123456')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('connecting: Fetch is disabled', async () => {
    fakeProjectApi(PROJECT, CONNECTING);
    await renderLoaded();
    await within(card()).findByText('Connecting');

    expect(fetchButton().disabled).toBe(true);
  });

  it('polls while fetching, then shows the new commit and toasts "Fetched <branch> · <commit>"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeProjectApi(PROJECT, READY);
    await renderLoaded();
    await within(card()).findByText('Connected');
    await userEvent.click(fetchButton());
    await within(card()).findByText('Fetching');

    api.state.repository = {
      ...READY,
      headSha: NEW_SHA,
      lastFetchedAt: '2026-11-13T11:00:00.000Z',
    };
    await act(() => vi.advanceTimersByTimeAsync(2_100));

    expect(await screen.findByText('Fetched dev · fedcba9')).toBeTruthy();
    expect(within(card()).getByText('fedcba9')).toBeTruthy();
    expect(within(card()).getByText('Connected')).toBeTruthy();
    const afterReady = api.calls('repository').length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.calls('repository').length).toBe(afterReady);
  });

  it('toasts "Already up to date" when the commit did not change', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeProjectApi(PROJECT, READY);
    await renderLoaded();
    await within(card()).findByText('Connected');
    await userEvent.click(fetchButton());
    await within(card()).findByText('Fetching');

    api.state.repository = { ...READY, lastFetchedAt: '2026-11-13T11:00:00.000Z' };
    await act(() => vi.advanceTimersByTimeAsync(2_100));

    expect(await screen.findByText('Already up to date')).toBeTruthy();
  });

  it('does not toast when a ready Repository is merely shown', async () => {
    fakeProjectApi(PROJECT, READY);
    await renderLoaded();
    await within(card()).findByText('Connected');

    expect(screen.queryByText(/Fetched|Already up to date/)).toBeNull();
  });

  it('failed fetch: keeps the previous commit and Last fetched visible and offers Fetch again', async () => {
    fakeProjectApi(PROJECT, failedFetch({ code: 'host_unreachable', detail: 'fatal: <redacted>' }));
    const { container } = await renderLoaded();

    const alert = await within(card()).findByRole('alert');
    expect(alert.textContent).toContain('Fetch failed.');
    expect(alert.textContent).toContain('Studio could not reach the Git host.');
    expect(within(card()).getByLabelText('Git output').textContent).toBe('fatal: <redacted>');
    expect(within(card()).getByText('0123456')).toBeTruthy();
    expect(card().querySelector('time')?.getAttribute('dateTime')).toBe(READY.lastFetchedAt);
    expect(within(card()).getByText('Failed')).toBeTruthy();
    expect(fetchButton().disabled).toBe(false);
    expect(within(card()).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(within(card()).queryByText('No repository connected')).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('failed fetch: Fetch again starts a new fetch', async () => {
    const api = fakeProjectApi(PROJECT, failedFetch({ code: 'timeout', detail: '' }));
    await renderLoaded();

    await userEvent.click(await within(card()).findByRole('button', { name: 'Fetch' }));

    await within(card()).findByText('Fetching');
    expect(api.calls('fetch')).toHaveLength(1);
  });

  it.each([
    [
      'branch_not_found',
      'The branch "release" no longer exists on the remote. Change the settings to use another branch.',
    ],
    ['timeout', 'The Git host took too long, so the fetch was stopped.'],
    ['unknown', 'The fetch failed for an unexpected reason.'],
  ] as const)('failed fetch (%s): says so in fetch terms', async (code, message) => {
    fakeProjectApi(PROJECT, failedFetch({ code, detail: '' }, 'release'));
    await renderLoaded();

    expect((await within(card()).findByRole('alert')).textContent).toContain(message);
  });

  it('failed fetch after a crash: says the fetch was interrupted', async () => {
    fakeProjectApi(PROJECT, failedFetch({ code: 'interrupted', detail: '' }));
    await renderLoaded();

    expect((await within(card()).findByRole('alert')).textContent).toMatch(
      /The fetch was interrupted/,
    );
  });

  it('failed without a usable Clone (size limit hit by a fetch): offers Retry, not Fetch', async () => {
    fakeProjectApi(PROJECT, failed({ code: 'size_limit', detail: '' }));
    await renderLoaded();

    expect((await within(card()).findByRole('alert')).textContent).toMatch(/2 GB limit/);
    expect(within(card()).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(within(card()).queryByRole('button', { name: /^Fetch/ })).toBeNull();
  });

  it('on a 409 (a fetch already running) reads the Repository again and shows it fetching', async () => {
    const api = fakeProjectApi(PROJECT, READY);
    await renderLoaded();
    await within(card()).findByText('Connected');
    // Another tab started a fetch: the server is ahead of this card.
    api.state.repository = { ...READY, state: 'fetching' };
    const reads = api.calls('repository').length;

    await userEvent.click(fetchButton());

    expect(await within(card()).findByText('Fetching')).toBeTruthy();
    expect(api.calls('fetch')).toHaveLength(1);
    expect(api.calls('repository').length).toBeGreaterThan(reads);
    expect(fetchButton().disabled).toBe(true);
  });

  it('ignores an older read still in flight when Fetch starts (no false toast, keeps polling)', async () => {
    const api = fakeProjectApi(PROJECT, READY);
    await renderLoaded();
    await within(card()).findByText('Connected');
    // A refetch on focus is on its way and will answer with the old `ready`.
    const release = api.holdNext('repository');
    const reads = api.calls('repository').length;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(api.calls('repository').length).toBe(reads + 1));

    await userEvent.click(fetchButton());
    await within(card()).findByText('Fetching');
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(within(card()).getByText('Fetching')).toBeTruthy();
    expect(screen.queryByText(/Already up to date|Fetched/)).toBeNull();
  });

  it('shows a Fetch that the API refuses as a banner, with the problem title', async () => {
    const api = fakeProjectApi(PROJECT, READY);
    api.respondNext('fetch', 409, problem(409, 'Repository busy'));
    await renderLoaded();
    await within(card()).findByText('Connected');

    await userEvent.click(fetchButton());

    await waitFor(() =>
      expect(
        within(card())
          .getAllByRole('alert')
          .map((alert) => alert.textContent),
      ).toContainEqual(expect.stringContaining('Repository busy')),
    );
  });
});

describe('Disconnect (Story #63)', () => {
  const DISCONNECTING: RepositoryOutput = {
    state: 'disconnecting',
    url: URL,
    integrationBranch: 'dev',
    hasClone: false,
  };
  const disconnectAction = () =>
    within(card()).getByRole<HTMLButtonElement>('button', { name: /^Disconnect/ });
  const confirmDialog = () => screen.getByRole('alertdialog', { name: 'Disconnect repository' });

  async function openConfirm() {
    await userEvent.click(await within(card()).findByRole('button', { name: 'Disconnect' }));
    return confirmDialog();
  }

  it.each([
    ['ready', READY, 'Connected'],
    ['connecting', CONNECTING, 'Connecting'],
    ['fetching', { ...READY, state: 'fetching' } as RepositoryOutput, 'Fetching'],
    ['failed', failed({ code: 'host_unreachable', detail: '' }), 'Failed'],
  ])('offers an outlined Disconnect while %s', async (_case, repository, pill) => {
    fakeProjectApi(PROJECT, repository);
    await renderLoaded();
    await within(card()).findByText(pill);

    expect(disconnectAction().dataset.variant).toBe('danger');
    expect(disconnectAction().disabled).toBe(false);
  });

  it('offers no Disconnect when no repository is connected', async () => {
    fakeProjectApi(PROJECT);
    await renderLoaded();
    await within(card()).findByRole('heading', { name: 'No repository connected' });

    expect(within(card()).queryByRole('button', { name: /Disconnect/ })).toBeNull();
  });

  it('asks for confirmation naming the repository and saying what is kept and deleted', async () => {
    const api = fakeProjectApi(PROJECT, READY);
    await renderLoaded();

    const dialog = await openConfirm();

    expect(within(dialog).getByRole('heading', { name: 'Disconnect repository' })).toBeTruthy();
    expect(within(dialog).getByText(URL).tagName).toBe('CODE');
    const text = dialog.textContent ?? '';
    expect(text).toContain('The project is kept.');
    expect(text).toContain("Studio's clone and deploy key are deleted.");
    expect(text).toContain('The remote repository is untouched.');
    expect(text).toContain('A deploy key added on the Git host stays there until removed there.');
    const confirm = within(dialog).getByRole('button', { name: 'Disconnect repository' });
    expect(confirm.dataset.variant).toBe('destructive');
    expect(within(dialog).getByRole('button', { name: 'Cancel' }).dataset.variant).toBe('ghost');
    // Nothing is sent before the operator confirms.
    expect(api.calls('disconnect')).toEqual([]);
    await expect(dialog).toHaveNoAxeViolations();
  });

  it('traps focus in the dialog and closes on Esc without disconnecting', async () => {
    const api = fakeProjectApi(PROJECT, READY);
    await renderLoaded();
    const dialog = await openConfirm();

    for (let i = 0; i < 5; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.calls('disconnect')).toEqual([]);
    expect(within(card()).getByText('Connected')).toBeTruthy();
  });

  it('confirming disconnects: the dialog closes, a toast confirms and the card is empty again', async () => {
    const api = fakeProjectApi(PROJECT, READY);
    await renderLoaded();
    const dialog = await openConfirm();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect repository' }));

    expect(await screen.findByText('Repository disconnected')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(
      await within(card()).findByRole('heading', { name: 'No repository connected' }),
    ).toBeTruthy();
    expect(within(card()).getByRole('button', { name: 'Connect repository' })).toBeTruthy();
    expect(api.calls('disconnect')).toHaveLength(1);
  });

  it('cleanup pending (202): shows Disconnecting… and polls until it is gone, then toasts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeProjectApi(PROJECT, READY);
    api.state.cleanupPending = true;
    await renderLoaded();
    const dialog = await openConfirm();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect repository' }));

    // The dialog closes on the 202; the card takes over.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await within(card()).findByText('Disconnecting…')).toBeTruthy();
    expect(within(card()).queryByRole('heading', { name: 'No repository connected' })).toBeNull();
    expect(screen.queryByText('Repository disconnected')).toBeNull();
    const before = api.calls('repository').length;
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(api.calls('repository').length).toBeGreaterThan(before);

    // The server finishes the cleanup (a retry at start-up, say): the Repository is gone.
    api.state.repository = null;
    await act(() => vi.advanceTimersByTimeAsync(2_100));

    expect(await screen.findByText('Repository disconnected')).toBeTruthy();
    expect(
      await within(card()).findByRole('heading', { name: 'No repository connected' }),
    ).toBeTruthy();
    // Confirmed once, however often the card re-rendered meanwhile.
    expect(screen.getAllByText('Repository disconnected')).toHaveLength(1);
    const afterGone = api.calls('repository').length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.calls('repository').length).toBe(afterGone);
  });

  it('disconnecting when loaded: says so, not the empty state, and Disconnect retries the cleanup', async () => {
    const api = fakeProjectApi(PROJECT, DISCONNECTING);
    const { container } = await renderLoaded();

    expect(await within(card()).findByText('Disconnecting…')).toBeTruthy();
    expect(within(card()).getByRole('status').textContent).toMatch(/Removing Studio's copy/);
    expect(within(card()).getByText(URL)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();

    await userEvent.click(disconnectAction());
    await userEvent.click(
      within(confirmDialog()).getByRole('button', { name: 'Disconnect repository' }),
    );

    expect(await screen.findByText('Repository disconnected')).toBeTruthy();
    expect(api.calls('disconnect')).toHaveLength(1);
  });

  it('confirms once when polling sees the Repository gone before the retried disconnect answers 204', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeProjectApi(PROJECT, DISCONNECTING);
    await renderLoaded();
    await within(card()).findByText('Disconnecting…');
    await userEvent.click(disconnectAction());
    // The retried DELETE removes everything on the server, but its 204 is held back…
    const release = api.holdNext('disconnect');
    await userEvent.click(
      within(confirmDialog()).getByRole('button', { name: 'Disconnect repository' }),
    );
    await waitFor(() => expect(api.calls('disconnect')).toHaveLength(1));

    // …so the next poll sees the Repository gone (404) first and confirms it…
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(await screen.findByText('Repository disconnected')).toBeTruthy();

    // …and the late 204 does not confirm it a second time.
    release();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.getAllByText('Repository disconnected')).toHaveLength(1);
    expect(within(card()).getByRole('heading', { name: 'No repository connected' })).toBeTruthy();
  });

  it('shows a disconnect the API refuses as a banner in the dialog, with the problem title', async () => {
    const api = fakeProjectApi(PROJECT, READY);
    api.respondNext('disconnect', 501, problem(501, 'Unsupported platform'));
    await renderLoaded();
    const dialog = await openConfirm();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect repository' }));

    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).getByRole('alert').textContent).toContain('Unsupported platform');
    // The dialog stays open; behind it the card still shows the Repository as connected.
    expect(confirmDialog()).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Repository', hidden: true })).getByText(
        'Connected',
      ),
    ).toBeTruthy();
  });
});

describe('SSH repositories with a Deploy key (Story #62)', () => {
  const SSH_URL = 'git@github.com:acme/shop.git';
  const AWAITING_KEY: RepositoryOutput = {
    state: 'awaiting_key',
    url: SSH_URL,
    integrationBranch: 'dev',
    hasClone: false,
    publicKey: FAKE_PUBLIC_KEY,
  };
  const AWAITING_HOST_KEY: RepositoryOutput = {
    ...AWAITING_KEY,
    state: 'awaiting_host_key',
    hostKeyFingerprint: FAKE_FINGERPRINT,
  };
  /** The card's alert whose text matches, once it is shown. */
  const alertMatching = (pattern: RegExp) =>
    waitFor(() => {
      const alert = within(card())
        .getAllByRole('alert')
        .find((element) => pattern.test(element.textContent ?? ''));
      if (!alert) throw new Error(`no alert matches ${pattern}`);
      return alert;
    });

  const failedSsh = (failure: RepositoryOutput['failure']): RepositoryOutput => ({
    ...AWAITING_KEY,
    state: 'failed',
    failure,
  });

  it('connecting an SSH URL shows the public key to add, in mono, with its comment and Copy', async () => {
    const api = fakeProjectApi(PROJECT);
    const { container } = await renderLoaded();
    await openDialog();

    await submit(SSH_URL);

    await within(card()).findByText('Awaiting key');
    expect(api.calls('connect')).toEqual([
      { route: 'connect', body: { url: SSH_URL, integrationBranch: 'dev' } },
    ]);
    const key = within(card()).getByLabelText('Public key');
    expect(key.tagName).toBe('PRE');
    expect(key.textContent).toBe(FAKE_PUBLIC_KEY);
    // One long line that scrolls inside its own box (390px), reachable by keyboard.
    expect(key.className.split(' ')).toEqual(
      expect.arrayContaining(['overflow-x-auto', 'whitespace-pre', 'min-w-0', 'text-code']),
    );
    expect(key.getAttribute('tabindex')).toBe('0');
    expect(within(card()).getByText('studio-Acme-Shop').tagName).toBe('CODE');
    expect(card().textContent).toContain(
      'Add this as a deploy key on your Git host. Read access is enough for now.',
    );
    expect(within(card()).getByRole('button', { name: 'Verify and clone' })).toBeTruthy();
    // No private key ever reaches the screen.
    expect(card().textContent).not.toMatch(/PRIVATE KEY/);
    await expect(container).toHaveNoAxeViolations();
  });

  it('Copy puts the public key on the clipboard', async () => {
    fakeProjectApi(PROJECT, AWAITING_KEY);
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(await within(card()).findByRole('button', { name: 'Copy public key' }));

    expect(await navigator.clipboard.readText()).toBe(FAKE_PUBLIC_KEY);
    expect(within(card()).getByRole('button', { name: 'Copy public key' }).textContent).toMatch(
      /Copied/,
    );
  });

  it('Verify and clone on a trusted host starts the clone and polls', async () => {
    const api = fakeProjectApi(PROJECT, AWAITING_KEY);
    api.state.hostTrusted = true;
    await renderLoaded();

    await userEvent.click(await within(card()).findByRole('button', { name: 'Verify and clone' }));

    await within(card()).findByText('Connecting');
    expect(api.calls('verify')).toEqual([{ route: 'verify', body: {} }]);
    expect(within(card()).getByRole('status').textContent).toMatch(/Cloning the repository/);
  });

  it('an unknown host: shows the host and fingerprint in mono; Confirm pins it and clones', async () => {
    const api = fakeProjectApi(PROJECT, AWAITING_KEY);
    const { container } = await renderLoaded();

    await userEvent.click(await within(card()).findByRole('button', { name: 'Verify and clone' }));

    const question = await within(card()).findByRole('region', {
      name: "Confirm the Git host's key",
    });
    expect(within(question).getByText('github.com').tagName).toBe('CODE');
    expect(within(question).getByText(FAKE_FINGERPRINT).tagName).toBe('CODE');
    expect(within(card()).getByText('Confirm host')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();

    await userEvent.click(within(question).getByRole('button', { name: 'Confirm and clone' }));

    await within(card()).findByText('Connecting');
    expect(api.calls('verify')).toEqual([
      { route: 'verify', body: {} },
      { route: 'verify', body: { acceptHostKeyFingerprint: FAKE_FINGERPRINT } },
    ]);
  });

  it('Cancel trusts nothing; Verify and clone asks again', async () => {
    const api = fakeProjectApi(PROJECT, AWAITING_HOST_KEY);
    await renderLoaded();

    await userEvent.click(await within(card()).findByRole('button', { name: 'Cancel' }));

    expect(within(card()).queryByRole('region', { name: "Confirm the Git host's key" })).toBeNull();
    expect(within(card()).getByText(/Host key not confirmed/)).toBeTruthy();
    expect(api.calls('verify')).toEqual([]);

    await userEvent.click(within(card()).getByRole('button', { name: 'Verify and clone' }));

    await within(card()).findByRole('region', { name: "Confirm the Git host's key" });
    expect(api.calls('verify')).toEqual([{ route: 'verify', body: {} }]);
  });

  it('a fingerprint the API refuses (422) is shown next to the question', async () => {
    const api = fakeProjectApi(PROJECT, AWAITING_HOST_KEY);
    api.respondNext(
      'verify',
      422,
      fieldProblem(422, 'Unprocessable Entity', [
        {
          path: 'acceptHostKeyFingerprint',
          message: 'The fingerprint does not match the host key Studio retrieved.',
        },
      ]),
    );
    await renderLoaded();

    await userEvent.click(await within(card()).findByRole('button', { name: 'Confirm and clone' }));

    await alertMatching(/Fingerprint changed\..*does not match the host key Studio retrieved/);
    expect(within(card()).getByText('Confirm host')).toBeTruthy();
  });

  it('a verify the API refuses (501) is shown as a banner with the problem title', async () => {
    const api = fakeProjectApi(PROJECT, AWAITING_KEY);
    api.respondNext('verify', 501, problem(501, 'Unsupported platform'));
    await renderLoaded();

    await userEvent.click(await within(card()).findByRole('button', { name: 'Verify and clone' }));

    await waitFor(() =>
      expect(
        within(card())
          .getAllByRole('alert')
          .map((alert) => alert.textContent),
      ).toContainEqual(expect.stringContaining('Unsupported platform')),
    );
  });

  it('auth_failed: points back to the deploy key, keeps it on screen, and Retry verifies again', async () => {
    const api = fakeProjectApi(
      PROJECT,
      failedSsh({ code: 'auth_failed', detail: 'git@github.com: Permission denied (publickey).' }),
    );
    api.state.hostTrusted = true;
    await renderLoaded();

    expect((await alertMatching(/Clone failed/)).textContent).toMatch(
      /refused Studio's deploy key.*The key stays the same/,
    );
    expect(within(card()).getByLabelText('Public key').textContent).toBe(FAKE_PUBLIC_KEY);

    await userEvent.click(within(card()).getByRole('button', { name: 'Retry' }));

    await within(card()).findByText('Connecting');
    expect(api.calls('verify')).toEqual([{ route: 'verify', body: {} }]);
    expect(api.calls('connect')).toEqual([]);
  });

  it('host_key_mismatch: says the key changed and how to accept an expected change', async () => {
    fakeProjectApi(PROJECT, failedSsh({ code: 'host_key_mismatch', detail: '' }));
    await renderLoaded();

    expect((await alertMatching(/Clone failed/)).textContent).toMatch(
      /different host key.*disconnect the repository and connect it again/,
    );
  });

  it('a failed SSH fetch names the deploy key, not HTTPS credentials', async () => {
    fakeProjectApi(PROJECT, {
      ...READY,
      url: SSH_URL,
      publicKey: FAKE_PUBLIC_KEY,
      state: 'failed',
      failure: { code: 'auth_failed', detail: '' },
    });
    await renderLoaded();

    const alert = await alertMatching(/Fetch failed/);
    expect(alert.textContent).toMatch(/deploy key/);
    expect(alert.textContent).not.toMatch(/HTTPS/);
  });
});
