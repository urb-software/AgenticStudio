import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewBuildOutput } from '../../../platform/api';
import { PreviewPage } from '..';
import { PREVIEW_BUILDING_POLL_MS } from '../api/preview-queries';
import {
  BUILD_ID,
  COMMIT,
  fakePreviewApi,
  PROJECT_ID,
  problem,
  QUEUED_BUILD,
} from './fake-preview-api';

// Stop, Reset data and its confirmation, the limit banner and the new states of the build card.

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

const RUNNING_PREVIEW = {
  settings: SETTINGS,
  state: 'running' as const,
  running: RUNNING,
  latestBuild: SUCCEEDED,
};

const STOPPED_PREVIEW = { settings: SETTINGS, latestBuild: SUCCEEDED, state: 'stopped' as const };

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PreviewPage projectId={PROJECT_ID} />
    </QueryClientProvider>,
  );
}

const card = () => screen.findByRole('region', { name: 'Preview build' });
const confirmDialog = () => screen.findByRole('alertdialog', { name: "Reset the Preview's data?" });

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Preview build card: Stop', () => {
  it('offers no Stop without a connected controller', async () => {
    fakePreviewApi({ ...RUNNING_PREVIEW, controllerConnected: false });
    renderPage();

    expect(within(await card()).queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('offers no Stop on a Preview that is not running', async () => {
    fakePreviewApi(STOPPED_PREVIEW);
    renderPage();

    const region = await card();
    expect(within(region).getByText('Stopped')).toBeTruthy();
    expect(within(region).queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('stops the Preview and shows Stopping with the other buttons disabled', async () => {
    const api = fakePreviewApi(RUNNING_PREVIEW);
    renderPage();

    const region = await card();
    await userEvent.click(within(region).getByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(api.stops).toHaveLength(1));
    expect(await within(region).findByText('Stopping')).toBeTruthy();
    expect(within(region).getByText('Stopping the Preview.')).toBeTruthy();
    expect(within(region).queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(within(region).getByRole('button', { name: 'Build' })).toHaveProperty('disabled', true);
    expect(within(region).getByRole('button', { name: 'Reset data…' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('disables the buttons while the request is pending', async () => {
    const api = fakePreviewApi(RUNNING_PREVIEW);
    renderPage();
    const region = await card();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = api.fetch.getMockImplementation()!;
    api.fetch.mockImplementation(async (request: Request) => {
      if (new URL(request.url).pathname.endsWith('/stop')) await held;
      return original(request);
    });

    await userEvent.click(within(region).getByRole('button', { name: 'Stop' }));

    await waitFor(() =>
      expect(within(region).getByRole('button', { name: 'Stop' })).toHaveProperty('disabled', true),
    );
    expect(within(region).getByRole('button', { name: 'Reset data…' })).toHaveProperty(
      'disabled',
      true,
    );
    release();
    expect(await within(region).findByText('Stopping')).toBeTruthy();
  });

  it('shows a refused stop as a banner and reads the Preview again', async () => {
    const api = fakePreviewApi(RUNNING_PREVIEW);
    renderPage();
    const region = await card();
    api.respondNext(409, problem(409, 'The Preview is not running'));
    api.state.stateOverride = 'stopped';

    await userEvent.click(within(region).getByRole('button', { name: 'Stop' }));

    expect(await within(region).findByText('The Preview was not stopped.')).toBeTruthy();
    expect(await within(region).findByText('Stopped')).toBeTruthy();
  });

  it('shows a failed stop from the latest change', async () => {
    fakePreviewApi({
      ...RUNNING_PREVIEW,
      latestChange: {
        kind: 'stop',
        status: 'failed',
        requestedAt: '2026-11-24T11:00:00.000Z',
        finishedAt: '2026-11-24T11:00:30.000Z',
        failure: { code: 'controller_error', detail: 'docker said no' },
      },
    });
    renderPage();

    const region = await card();
    expect(within(region).getByText('The stop failed.')).toBeTruthy();
    expect(within(region).getByText('The environment controller hit an error.')).toBeTruthy();
    expect(within(region).getByText('docker said no')).toBeTruthy();
  });

  it('does not show a finished change as a failure', async () => {
    fakePreviewApi({
      ...RUNNING_PREVIEW,
      latestChange: {
        kind: 'reset_data',
        status: 'succeeded',
        requestedAt: '2026-11-24T11:00:00.000Z',
        finishedAt: '2026-11-24T11:00:30.000Z',
        failure: null,
      },
    });
    renderPage();

    expect(within(await card()).queryByText(/failed/i)).toBeNull();
  });
});

describe('Preview build card: Reset data', () => {
  it('is not offered without a connected controller', async () => {
    fakePreviewApi({ ...RUNNING_PREVIEW, controllerConnected: false });
    renderPage();

    expect(within(await card()).queryByRole('button', { name: 'Reset data…' })).toBeNull();
  });

  it('is not offered before any build exists', async () => {
    fakePreviewApi({ settings: SETTINGS });
    renderPage();

    expect(within(await card()).queryByRole('button', { name: 'Reset data…' })).toBeNull();
  });

  it('is enabled on a stopped Preview that was built', async () => {
    fakePreviewApi(STOPPED_PREVIEW);
    renderPage();

    expect(within(await card()).getByRole('button', { name: 'Reset data…' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it.each(['building', 'stopping', 'resetting_data'] as const)(
    'is disabled while the Preview is %s',
    async (state) => {
      fakePreviewApi({ settings: SETTINGS, latestBuild: SUCCEEDED, state });
      renderPage();

      const button = within(await card()).getByRole('button', { name: 'Reset data…' });
      expect(button).toHaveProperty('disabled', true);
    },
  );

  it('confirms with the Project and the commit of a running Preview, focus in the dialog', async () => {
    const api = fakePreviewApi(RUNNING_PREVIEW);
    renderPage();
    const region = await card();

    await userEvent.click(within(region).getByRole('button', { name: 'Reset data…' }));

    const dialog = await confirmDialog();
    expect(dialog.textContent).toContain(
      "This removes the volumes of Acme Shop's Preview for good: its databases, uploads and anything else it stored.",
    );
    expect(dialog.textContent).toContain('The Preview is then rebuilt from commit 0123456.');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(api.resets).toHaveLength(0);
  });

  it('leaves out the rebuild sentence when nothing runs', async () => {
    fakePreviewApi(STOPPED_PREVIEW);
    renderPage();
    await userEvent.click(within(await card()).getByRole('button', { name: 'Reset data…' }));

    const dialog = await confirmDialog();
    expect(dialog.textContent).not.toContain('rebuilt');
  });

  it('cancels without asking', async () => {
    const api = fakePreviewApi(RUNNING_PREVIEW);
    renderPage();
    await userEvent.click(within(await card()).getByRole('button', { name: 'Reset data…' }));

    await userEvent.click(within(await confirmDialog()).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.resets).toHaveLength(0);
  });

  it('resets, closes the dialog and shows Resetting data', async () => {
    const api = fakePreviewApi(RUNNING_PREVIEW);
    renderPage();
    const region = await card();
    await userEvent.click(within(region).getByRole('button', { name: 'Reset data…' }));

    await userEvent.click(
      within(await confirmDialog()).getByRole('button', { name: 'Reset data' }),
    );

    await waitFor(() => expect(api.resets).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await within(region).findByText('Resetting data')).toBeTruthy();
    expect(within(region).getByText("Removing the Preview's data.")).toBeTruthy();
  });

  it('shows a refusal as a banner in the dialog and keeps it open', async () => {
    const api = fakePreviewApi(RUNNING_PREVIEW);
    renderPage();
    await userEvent.click(within(await card()).getByRole('button', { name: 'Reset data…' }));
    api.respondNext(409, problem(409, 'Another change is running'));

    const dialog = await confirmDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset data' }));

    expect(await within(dialog).findByText('Another change is running')).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('shows a failed reset from the latest change', async () => {
    fakePreviewApi({
      ...RUNNING_PREVIEW,
      latestChange: {
        kind: 'reset_data',
        status: 'failed',
        requestedAt: '2026-11-24T11:00:00.000Z',
        finishedAt: '2026-11-24T11:00:30.000Z',
        failure: { code: 'controller_lost', detail: '' },
      },
    });
    renderPage();

    expect(within(await card()).getByText('Removing the data failed.')).toBeTruthy();
  });
});

describe('Preview build card: the running limit', () => {
  const A = '00000000-0000-4000-8000-0000000000a1';
  const B = '00000000-0000-4000-8000-0000000000b2';
  const C = '00000000-0000-4000-8000-0000000000c3';
  const LIMIT_PROBLEM = {
    ...problem(409, 'Too many Previews running'),
    detail: 'At most 3 Previews run at the same time. Running now: A, B, C. Stop one first.',
    running: [
      { projectId: A, name: 'A', state: 'running' },
      { projectId: B, name: 'B', state: 'building' },
      { projectId: C, name: 'C', state: 'running' },
    ],
  };

  it('shows the detail with a link to each running Preview page', async () => {
    const api = fakePreviewApi({ settings: SETTINGS });
    renderPage();
    const region = await card();
    api.respondNext(409, LIMIT_PROBLEM);

    await userEvent.click(within(region).getByRole('button', { name: 'Build' }));

    expect(await within(region).findByText(LIMIT_PROBLEM.detail)).toBeTruthy();
    const links = within(region).getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['A', `/projects/${A}/preview`],
      ['B', `/projects/${B}/preview`],
      ['C', `/projects/${C}/preview`],
    ]);
    expect(within(region).queryByText('The build was not started.')).toBeNull();
  });

  it('shows any other 409 of a build as the plain banner', async () => {
    const api = fakePreviewApi({ settings: SETTINGS });
    renderPage();
    const region = await card();
    api.respondNext(409, problem(409, 'busy'));

    await userEvent.click(within(region).getByRole('button', { name: 'Build' }));

    expect(await within(region).findByText('The build was not started.')).toBeTruthy();
  });
});

describe('Preview build card: polling and accessibility', () => {
  const previewReads = (api: ReturnType<typeof fakePreviewApi>) =>
    api.fetch.mock.calls.filter(([request]) => new URL(request.url).pathname.endsWith('/preview'))
      .length;

  it.each(['stopping', 'resetting_data'] as const)('polls every 2 s while %s', async (state) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakePreviewApi({ settings: SETTINGS, latestBuild: SUCCEEDED, state });
    renderPage();
    await card();
    const before = previewReads(api);

    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_BUILDING_POLL_MS + 100));

    expect(previewReads(api)).toBe(before + 1);
  });

  it.each([
    ['running', RUNNING_PREVIEW],
    ['stopping', { settings: SETTINGS, latestBuild: SUCCEEDED, state: 'stopping' as const }],
    [
      'resetting_data',
      { settings: SETTINGS, latestBuild: SUCCEEDED, state: 'resetting_data' as const },
    ],
  ] satisfies [string, Parameters<typeof fakePreviewApi>[0]][])(
    'has no axe violations while %s',
    async (_name, initial) => {
      fakePreviewApi(initial);
      const { container } = renderPage();
      await card();
      await expect(container).toHaveNoAxeViolations();
    },
  );

  it('has no axe violations with the confirmation open', async () => {
    fakePreviewApi(RUNNING_PREVIEW);
    renderPage();
    await userEvent.click(within(await card()).getByRole('button', { name: 'Reset data…' }));
    await confirmDialog();
    await expect(document.body).toHaveNoAxeViolations();
  });
});
