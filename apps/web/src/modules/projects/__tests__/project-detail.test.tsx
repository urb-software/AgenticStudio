import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectDetail } from '..';
import type { ProjectOutput, RepositoryOutput } from '../../../platform/api';
import { fakeProjectApi, fieldProblem } from './fake-project-api';
import { problem } from './fake-projects-api';

// Project screen seam (Story #60): the public ProjectDetail of the projects module, with the
// generated client, the API wrapper and TanStack Query real, and the API faked at `fetch`.

const PROJECT: ProjectOutput = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Acme Shop',
  createdAt: '2026-11-12T09:00:00.000Z',
};
const URL = 'https://github.com/acme/shop.git';
const SHA = '0123456789abcdef0123456789abcdef01234567';

const CONNECTING: RepositoryOutput = { state: 'connecting', url: URL, integrationBranch: 'dev' };
const READY: RepositoryOutput = {
  state: 'ready',
  url: URL,
  integrationBranch: 'dev',
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
  failure,
});

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectDetail projectId={PROJECT.id} />
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
  act(() => focusManager.setFocused(undefined));
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
    ['an SSH URL (422)', 422, 'Private repositories over SSH are not supported yet.'],
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
      'The repository is larger than the 2 GB limit, so the clone was stopped.',
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

  it('failed after a crash: says the clone was interrupted', async () => {
    fakeProjectApi(PROJECT, failed({ code: 'unknown', detail: 'Interrupted' }));
    await renderLoaded();

    expect((await within(card()).findByRole('alert')).textContent).toMatch(/interrupted/);
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
