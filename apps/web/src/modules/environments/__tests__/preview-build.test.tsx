import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewBuildOutput } from '../../../platform/api';
import { PreviewPage } from '..';
import {
  BUILD_ID,
  COMMIT,
  fakePreviewApi,
  logLine,
  PROJECT_ID,
  problem,
  QUEUED_BUILD,
} from './fake-preview-api';

// The build card of the Preview page, with the API faked at `fetch`.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SETTINGS = {
  composeFile: 'compose.yaml',
  service: 'web',
  port: 3000,
  updatedAt: '2026-11-23T10:00:00.000Z',
};

const SUCCEEDED: PreviewBuildOutput = {
  ...QUEUED_BUILD,
  status: 'succeeded',
  startedAt: '2026-11-24T10:00:02.000Z',
  finishedAt: '2026-11-24T10:03:00.000Z',
};

const RUNNING = {
  buildId: BUILD_ID,
  commit: COMMIT,
  since: '2026-11-24T10:03:00.000Z',
  url: 'https://preview-3f2b8c1e4d5a.example.test/',
};

const FAILED: PreviewBuildOutput = {
  ...SUCCEEDED,
  status: 'failed',
  failure: {
    code: 'build_failed',
    detail: 'npm exited with 1',
    refusals: [],
    previewRemoved: false,
  },
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PreviewPage projectId={PROJECT_ID} />
    </QueryClientProvider>,
  );
}

const card = () => screen.findByRole('region', { name: 'Preview build' });

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Preview build card: state and button', () => {
  it('shows no button for a Preview without settings', async () => {
    fakePreviewApi();
    renderPage();

    const region = await card();
    expect(within(region).getByText('Not configured')).toBeTruthy();
    expect(within(region).queryByRole('button')).toBeNull();
  });

  it('offers Build for a Preview that was never built, and asks for a build', async () => {
    const api = fakePreviewApi({ settings: SETTINGS });
    renderPage();

    const region = await card();
    expect(within(region).getByText('Stopped')).toBeTruthy();
    await userEvent.click(within(region).getByRole('button', { name: 'Build' }));

    await waitFor(() => expect(api.builds).toHaveLength(1));
    expect(await within(region).findByText('Building')).toBeTruthy();
    const button = within(region).getByRole('button', { name: 'Build' });
    expect(button).toHaveProperty('disabled', true);
  });

  it('says there is no controller and offers no button', async () => {
    fakePreviewApi({ settings: SETTINGS, controllerConnected: false });
    renderPage();

    const region = await card();
    expect(
      within(region).getByText(
        'No environment controller is connected. Builds start once it runs.',
      ),
    ).toBeTruthy();
    expect(within(region).queryByRole('button', { name: /build/i })).toBeNull();
  });

  it('offers no button while the repository is not ready', async () => {
    fakePreviewApi({
      settings: SETTINGS,
      repository: { ready: false, reason: 'repository_not_ready' },
    });
    renderPage();

    const region = await card();
    expect(within(region).queryByRole('button', { name: /build/i })).toBeNull();
  });

  it('offers Rebuild, the commit in seven characters and the link, while it runs', async () => {
    fakePreviewApi({
      settings: SETTINGS,
      state: 'running',
      running: RUNNING,
      latestBuild: SUCCEEDED,
    });
    renderPage();

    const region = await card();
    expect(within(region).getByText('Running')).toBeTruthy();
    const commit = within(region).getAllByText(COMMIT.slice(0, 7))[0]!;
    expect(commit.getAttribute('title')).toBe(COMMIT);
    expect(within(region).getByRole('button', { name: 'Rebuild' })).toHaveProperty(
      'disabled',
      false,
    );
    const link = within(region).getByRole('link', {
      name: 'Open the Preview (opens in a new tab)',
    });
    expect(link.getAttribute('href')).toBe('https://preview-3f2b8c1e4d5a.example.test/');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(document.querySelector('iframe')).toBeNull();
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('has no link while the running build has no address', async () => {
    fakePreviewApi({
      settings: SETTINGS,
      hostname: null,
      state: 'running',
      running: { ...RUNNING, url: null },
      latestBuild: SUCCEEDED,
    });
    renderPage();

    const region = await card();
    expect(within(region).getByText('Running')).toBeTruthy();
    expect(within(region).queryByRole('link')).toBeNull();
  });

  it('offers Retry build after a failure, and says what failed', async () => {
    fakePreviewApi({ settings: SETTINGS, state: 'failed', latestBuild: FAILED });
    renderPage();

    const region = await card();
    expect(
      within(region)
        .getAllByText('Failed')
        .some((el) => el.matches('[data-slot="status-pill"]')),
    ).toBe(true);
    expect(within(region).getByRole('button', { name: 'Retry build' })).toBeTruthy();
    expect(within(region).getByText('The build did not succeed.')).toBeTruthy();
    expect(within(region).getByText('npm exited with 1')).toBeTruthy();
    expect(within(region).queryByText(/so the Preview was stopped/)).toBeNull();
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('says the Preview was stopped when the failed build removed it', async () => {
    fakePreviewApi({
      settings: SETTINGS,
      state: 'failed',
      latestBuild: {
        ...FAILED,
        failure: { ...FAILED.failure!, code: 'start_failed', previewRemoved: true },
      },
    });
    renderPage();

    const region = await card();
    expect(
      within(region).getByText('The new build could not start, so the Preview was stopped.'),
    ).toBeTruthy();
  });

  it('shows a failed build and the Preview that still runs', async () => {
    fakePreviewApi({
      settings: SETTINGS,
      state: 'running',
      running: RUNNING,
      latestBuild: FAILED,
    });
    renderPage();

    const region = await card();
    expect(within(region).getByRole('link', { name: /Open the Preview/ })).toBeTruthy();
    expect(within(region).getByText('npm exited with 1')).toBeTruthy();
  });

  it('shows the refusals of a failed build', async () => {
    fakePreviewApi({
      settings: SETTINGS,
      state: 'failed',
      latestBuild: {
        ...FAILED,
        failure: {
          code: 'validation_refused',
          detail: 'refused',
          previewRemoved: false,
          refusals: [
            { code: 'privileged', place: 'services.web.privileged', message: 'Not allowed.' },
          ],
        },
      },
    });
    renderPage();

    const region = await card();
    const list = within(region).getByRole('list', { name: 'Refusals' });
    expect(within(list).getByText('services.web.privileged')).toBeTruthy();
  });

  it('shows a fixed message for the failures only Studio sets', async () => {
    fakePreviewApi({
      settings: SETTINGS,
      state: 'failed',
      latestBuild: {
        ...FAILED,
        failure: { ...FAILED.failure!, code: 'not_claimed', detail: '' },
      },
    });
    renderPage();

    const region = await card();
    expect(within(region).getByText(/No environment controller picked up the build/)).toBeTruthy();
  });

  it('shows a 409 detail in a banner', async () => {
    const api = fakePreviewApi({ settings: SETTINGS });
    renderPage();
    const region = await card();
    api.respondNext(409, problem(409, 'A build is running'));

    await userEvent.click(within(region).getByRole('button', { name: 'Build' }));

    expect(await screen.findByText('A build is running (test)')).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Build' })).toHaveProperty('disabled', false);
  });

  it('shows the refusals of a 422', async () => {
    const api = fakePreviewApi({ settings: SETTINGS });
    renderPage();
    const region = await card();
    api.respondNext(
      422,
      problem(422, 'Preview refused', {
        refusals: [
          { code: 'docker_socket', place: 'services.web.volumes[0]', message: 'No socket.' },
        ],
      }),
    );

    await userEvent.click(within(region).getByRole('button', { name: 'Build' }));

    const list = await screen.findByRole('list', { name: 'Refusals' });
    expect(within(list).getByText('services.web.volumes[0]')).toBeTruthy();
    expect(screen.getByText('The build was not started.')).toBeTruthy();
  });

  it('falls back to the banner when a 422 holds no refusals', async () => {
    const api = fakePreviewApi({ settings: SETTINGS });
    renderPage();
    const region = await card();
    api.respondNext(422, problem(422, 'Preview refused'));

    await userEvent.click(within(region).getByRole('button', { name: 'Build' }));

    expect(await screen.findByText('Preview refused (test)')).toBeTruthy();
  });

  it('keeps the button disabled while the request is pending', async () => {
    const api = fakePreviewApi({ settings: SETTINGS });
    let release = () => {};
    api.state.buildGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderPage();
    const region = await card();

    await userEvent.click(within(region).getByRole('button', { name: 'Build' }));

    await waitFor(() => expect(api.builds).toHaveLength(1));
    expect(within(region).getByRole('button', { name: 'Build' })).toHaveProperty('disabled', true);
    release();
    expect(await within(region).findByText('Building')).toBeTruthy();
  });

  it('keeps the live text the same when the Preview is read again unchanged', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakePreviewApi({
      settings: SETTINGS,
      state: 'running',
      running: RUNNING,
      latestBuild: SUCCEEDED,
    });
    api.state.logs.set(BUILD_ID, []);
    api.state.finalBuilds.add(BUILD_ID);
    renderPage();
    const region = await card();
    const live = () => region.querySelector('[aria-live="polite"]')!.textContent;
    const before = live();
    expect(before).toContain(COMMIT.slice(0, 7));
    expect(before).not.toMatch(/ago|minute|hour|now/);

    await act(() => vi.advanceTimersByTimeAsync(16_000));

    expect(live()).toBe(before);
  });

  it('keeps the summary a polite live region', async () => {
    fakePreviewApi({ settings: SETTINGS });
    renderPage();

    const region = await card();
    const summary = within(region).getByText('The Preview is stopped.');
    expect(summary.closest('[aria-live="polite"]')).toBeTruthy();
  });
});

describe('Preview build card: polling and log', () => {
  it('reads the Preview every 2 seconds while it builds, then more slowly', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakePreviewApi({
      settings: SETTINGS,
      state: 'building',
      latestBuild: QUEUED_BUILD,
    });
    api.state.logs.set(BUILD_ID, []);
    renderPage();
    const region = await card();
    expect(within(region).getByText('Building')).toBeTruthy();

    api.state.stateOverride = 'running';
    api.state.running = RUNNING;
    api.state.latestBuild = SUCCEEDED;
    await act(() => vi.advanceTimersByTimeAsync(2100));

    expect(await within(region).findByText('Running')).toBeTruthy();
    const reads = () =>
      api.fetch.mock.calls.filter(([r]) => new URL(r.url).pathname.endsWith('/preview')).length;
    const before = reads();
    await act(() => vi.advanceTimersByTimeAsync(4100));
    expect(reads()).toBe(before);
    await act(() => vi.advanceTimersByTimeAsync(11_000));
    expect(reads()).toBe(before + 1);
  });

  it('reads the log in pages until the build is final, then stops', async () => {
    const api = fakePreviewApi({ settings: SETTINGS, state: 'failed', latestBuild: FAILED });
    api.state.logs.set(
      BUILD_ID,
      Array.from({ length: 1100 }, (_, i) => logLine(i + 1, `step ${i + 1}`)),
    );
    api.state.finalBuilds.add(BUILD_ID);
    renderPage();

    expect(await screen.findByText('1100 lines')).toBeTruthy();
    expect(api.eventRequests.map((r) => r.after)).toEqual([0, 500, 1000]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.eventRequests).toHaveLength(3);
  });

  it('follows a live log by polling after the last seq, until final', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakePreviewApi({
      settings: SETTINGS,
      state: 'building',
      latestBuild: { ...QUEUED_BUILD, status: 'building' },
    });
    api.state.logs.set(BUILD_ID, [logLine(1, 'one'), logLine(2, 'two')]);
    renderPage();
    expect(await screen.findByText('2 lines')).toBeTruthy();

    api.state.logs.set(BUILD_ID, [logLine(1, 'one'), logLine(2, 'two'), logLine(3, 'three')]);
    api.state.finalBuilds.add(BUILD_ID);
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(await screen.findByText('3 lines')).toBeTruthy();
    expect(api.eventRequests.at(-1)).toMatchObject({ after: 2 });

    const requests = api.eventRequests.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.eventRequests).toHaveLength(requests);
  });

  it('does not read the log while the tab is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const api = fakePreviewApi({
      settings: SETTINGS,
      state: 'building',
      latestBuild: { ...QUEUED_BUILD, status: 'building' },
    });
    api.state.logs.set(BUILD_ID, [logLine(1, 'one')]);
    renderPage();
    await card();

    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(api.eventRequests).toHaveLength(0);

    hidden.mockReturnValue(false);
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(await screen.findByText('1 line')).toBeTruthy();
    expect(api.eventRequests.length).toBeGreaterThan(0);
  });

  it('stops and says the log is not available when the server has none', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakePreviewApi({
      settings: SETTINGS,
      state: 'building',
      latestBuild: { ...QUEUED_BUILD, status: 'building' },
    });
    renderPage();

    expect(await screen.findByText('The log is not available.')).toBeTruthy();
    expect(screen.queryByText('Streaming')).toBeNull();
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
    const requests = api.eventRequests.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.eventRequests).toHaveLength(requests);
  });

  it('shows the lines as plain text', async () => {
    const api = fakePreviewApi({ settings: SETTINGS, state: 'failed', latestBuild: FAILED });
    api.state.logs.set(BUILD_ID, [logLine(1, '<img src=x onerror=alert(1)>')]);
    api.state.finalBuilds.add(BUILD_ID);
    renderPage();

    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('says when the log reached its size cap', async () => {
    const api = fakePreviewApi({ settings: SETTINGS, state: 'failed', latestBuild: FAILED });
    api.state.logs.set(BUILD_ID, [logLine(1, 'one')]);
    api.state.finalBuilds.add(BUILD_ID);
    api.state.logTruncated = true;
    renderPage();

    expect(await screen.findByText(/The log reached its size limit/)).toBeTruthy();
  });

  it('shows the build in progress without axe violations', async () => {
    const api = fakePreviewApi({
      settings: SETTINGS,
      state: 'building',
      latestBuild: { ...QUEUED_BUILD, status: 'building' },
    });
    api.state.logs.set(BUILD_ID, [logLine(1, 'one')]);
    renderPage();

    expect(await screen.findByText('1 line')).toBeTruthy();
    await expect(document.body).toHaveNoAxeViolations();
  });
});
