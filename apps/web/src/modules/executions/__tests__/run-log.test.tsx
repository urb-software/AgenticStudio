import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunDetail } from '..';
import type { RunStepOutput } from '../../../platform/api';
import { anEvent, aRun, fakeRunsApi } from './fake-runs-api';

// jsdom lays nothing out, so the viewer's height is stubbed (400px: 20 rows in view).

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

function renderRun(runId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RunDetail runId={runId} />
    </QueryClientProvider>,
  );
}

const log = () => screen.findByRole('log', { name: 'Run log' });
/** The text of every row in view, in order. */
const shown = async () =>
  [...(await log()).querySelectorAll('[data-slot="log-text"]')].map((text) => text.textContent);
const lineCount = () => screen.getByText(/^\d+ lines?$/).textContent;

const STEP: RunStepOutput = {
  index: 1,
  kind: 'start',
  outcome: 'done',
  summary: 'Added GET /health.',
  checks: [
    { name: 'unit tests', result: 'passed' },
    { name: 'lint', result: 'failed', detail: '2 errors' },
  ],
  reportedAt: '2026-11-15T10:01:00.000Z',
};

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Run log', () => {
  it('shows a finished Run’s stored log with step separators and the step result at its end', async () => {
    const run = aRun({ state: 'succeeded' });
    const api = fakeRunsApi([run]);
    api.storeEvents(
      run.id,
      anEvent(1, { kind: 'step_started', text: 'Run step 1 started' }),
      anEvent(2, { kind: 'message', text: 'I will add a health check.' }),
      anEvent(3, { kind: 'command', text: 'pnpm test' }),
      anEvent(4, { text: 'PASS 12 tests\nTOKEN=••••••[redacted]', redacted: true }),
      anEvent(5, { kind: 'step_finished', text: 'Run step 1 finished: done' }),
    );
    api.setSteps(run.id, [STEP]);
    const { container } = renderRun(run.id);

    await waitFor(async () => expect(await shown()).toContain('✗ lint'));
    expect(await shown()).toEqual([
      'Run step 1 started',
      'I will add a health check.',
      '$ pnpm test',
      'PASS 12 tests',
      'TOKEN=••••••[redacted]',
      'Run step 1 finished: done',
      'Result: done',
      'Added GET /health.',
      '✓ unit tests',
      '✗ lint',
      '    2 errors',
    ]);
    const rows = (await log()).querySelectorAll<HTMLElement>('[data-tone]');
    expect(rows[0]!.dataset.tone).toBe('section');
    expect(rows[2]!.dataset.tone).toBe('command');
    expect(rows[4]!.dataset.tone).toBe('warn');
    expect(rows[8]!.dataset.tone).toBe('ok');
    expect(rows[9]!.dataset.tone).toBe('error');
    // A finished Run's log is complete once paged: no live connection.
    expect(api.streams()).toEqual([]);
    expect(screen.queryByText('Streaming')).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('loads a long finished log in pages, without rendering it all', async () => {
    const run = aRun({ state: 'failed', failure: { code: 'agent_failed', detail: 'x' } });
    const api = fakeRunsApi([run]);
    api.storeEvents(run.id, ...Array.from({ length: 2500 }, (_, i) => anEvent(i + 1)));
    renderRun(run.id);

    await waitFor(() => expect(lineCount()).toBe('2500 lines'));
    expect(api.calls('events').map((call) => call.query?.get('after'))).toEqual([
      '0',
      '1000',
      '2000',
    ]);
    expect(api.calls('events').every((call) => call.query?.get('limit') === '1000')).toBe(true);
    expect((await log()).querySelectorAll('[data-tone]').length).toBeLessThan(100);
  });

  it('shows new entries of an active Run as they arrive, without a reload', async () => {
    const run = aRun({ state: 'running', startedAt: '2026-11-15T10:00:05.000Z' });
    const api = fakeRunsApi([run]);
    api.storeEvents(run.id, anEvent(1, { kind: 'step_started', text: 'Run step 1 started' }));
    renderRun(run.id);

    await waitFor(() => expect(api.streams()).toHaveLength(1));
    const [stream] = api.streams();
    expect(stream!.after).toBe(1);
    await screen.findByText('Streaming');
    act(() => stream!.push(anEvent(2, { text: 'working slowly: line 1' })));
    act(() => stream!.push(anEvent(3, { text: 'working slowly: line 2' })));

    await waitFor(async () =>
      expect(await shown()).toEqual([
        'Run step 1 started',
        'working slowly: line 1',
        'working slowly: line 2',
      ]),
    );
  });

  it('reconnects after a drop from the last entry it has: nothing lost, nothing twice', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = aRun({ state: 'running', startedAt: '2026-11-15T10:00:05.000Z' });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await waitFor(() => expect(api.streams()).toHaveLength(1));
    const first = api.streams()[0]!;
    act(() => first.push(anEvent(1), anEvent(2)));
    await waitFor(async () => expect(await shown()).toEqual(['line 1', 'line 2']));

    act(() => first.drop());
    expect(await screen.findByText(/Reconnecting…/)).toBeTruthy();
    expect(await shown()).toEqual(['line 1', 'line 2']);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await waitFor(() => expect(api.streams()).toHaveLength(2));
    const second = api.streams()[1]!;
    expect(second.after).toBe(2);
    // The server catches up from its store; a repeat of a seen entry is ignored.
    act(() => second.push(anEvent(2), anEvent(3), anEvent(4)));

    await waitFor(async () =>
      expect(await shown()).toEqual(['line 1', 'line 2', 'line 3', 'line 4']),
    );
    expect(screen.queryByText(/Reconnecting…/)).toBeNull();
    vi.useRealTimers();
  });

  it('reads the step result when a step finishes live, and stops once the Run ends', async () => {
    const run = aRun({ state: 'running', startedAt: '2026-11-15T10:00:05.000Z' });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await waitFor(() => expect(api.streams()).toHaveLength(1));
    const stream = api.streams()[0]!;

    api.setSteps(run.id, [STEP]);
    act(() =>
      stream.push(anEvent(1, { kind: 'step_finished', text: 'Run step 1 finished: done' })),
    );
    act(() => stream.end());

    await waitFor(async () => expect(await shown()).toContain('Added GET /health.'));
    await waitFor(() => expect(screen.queryByText('Streaming')).toBeNull());
    expect(api.streams()).toHaveLength(1);
  });

  it('shows a step result reported after its end marker once the Run state moves on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = aRun({ state: 'running', startedAt: '2026-11-15T10:00:05.000Z' });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await waitFor(() => expect(api.streams()).toHaveLength(1));

    // The worker sends the marker first, then reports the result and the waiting state; the
    // stream of a waiting Run does not end.
    act(() =>
      api
        .streams()[0]!
        .push(anEvent(1, { kind: 'step_finished', text: 'Run step 1 finished: needs_input' })),
    );
    await waitFor(async () => expect(await shown()).toEqual(['Run step 1 finished: needs_input']));
    api.setSteps(run.id, [{ ...STEP, outcome: 'needs_input', checks: [] }]);
    api.update(run.id, { state: 'waiting_for_operator' });
    await act(() => vi.advanceTimersByTimeAsync(2_500));

    await waitFor(async () => expect(await shown()).toContain('Result: needs input'));
    vi.useRealTimers();
  });

  it('sends the browser to the login page on a 401 from the stream, without reconnecting', async () => {
    const replace = vi.fn();
    vi.stubGlobal('location', { ...window.location, pathname: '/executions/x', replace });
    const run = aRun({ state: 'running', startedAt: '2026-11-15T10:00:05.000Z' });
    const api = fakeRunsApi([run]);
    api.respondNext('stream', 401, { status: 401, title: 'Unauthorized', detail: 'No session.' });
    renderRun(run.id);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(await screen.findByText('Couldn’t load the log.')).toBeTruthy();
    expect(api.calls('stream')).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('closes the live stream when the page goes away', async () => {
    const run = aRun({ state: 'running', startedAt: '2026-11-15T10:00:05.000Z' });
    const api = fakeRunsApi([run]);
    const { unmount } = renderRun(run.id);
    await waitFor(() => expect(api.streams()).toHaveLength(1));

    unmount();

    expect(api.streams()[0]!.aborted()).toBe(true);
  });

  it('backs off further while connections drop before they are stable', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = aRun({ state: 'running', startedAt: '2026-11-15T10:00:05.000Z' });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await waitFor(() => expect(api.streams()).toHaveLength(1));

    // Open, then dropped at once (no event, under 10 s): 1 s, then 2 s before reconnecting.
    act(() => api.streams()[0]!.drop());
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await waitFor(() => expect(api.streams()).toHaveLength(2));
    act(() => api.streams()[1]!.drop());
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(api.streams()).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await waitFor(() => expect(api.streams()).toHaveLength(3));

    // A connection that delivered an event was stable: the next wait is 1 s again.
    act(() => api.streams()[2]!.push(anEvent(1)));
    await waitFor(async () => expect(await shown()).toEqual(['line 1']));
    act(() => api.streams()[2]!.drop());
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await waitFor(() => expect(api.streams()).toHaveLength(4));
    vi.useRealTimers();
  });

  it('announces the live stream once, not again after a reconnect (Issue #115)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = aRun({ state: 'running', startedAt: '2026-11-15T10:00:05.000Z' });
    const api = fakeRunsApi([run]);
    renderRun(run.id);
    await waitFor(() => expect(api.streams()).toHaveLength(1));
    const announcement = await screen.findByText('The log is streaming live.');

    // The polite status keeps its words through the drop and the reconnect: no new message.
    act(() => api.streams()[0]!.drop());
    expect(await screen.findByText(/Reconnecting…/)).toBeTruthy();
    expect(announcement.textContent).toBe('The log is streaming live.');
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await waitFor(() => expect(api.streams()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText(/Reconnecting…/)).toBeNull());
    expect(announcement.textContent).toBe('The log is streaming live.');
    vi.useRealTimers();
  });

  it('backs off and reconnects on a 429 from the stream instead of stopping (Issue #115)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = aRun({ state: 'running', startedAt: '2026-11-15T10:00:05.000Z' });
    const api = fakeRunsApi([run]);
    api.respondNext('stream', 429, {
      status: 429,
      title: 'Too many live logs',
      detail: 'Too many live logs are open.',
    });
    renderRun(run.id);
    await waitFor(() => expect(api.calls('stream')).toHaveLength(1));

    expect(await screen.findByText(/Reconnecting…/)).toBeTruthy();
    expect(screen.queryByText('Couldn’t load the log.')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await waitFor(() => expect(api.streams()).toHaveLength(1));
    act(() => api.streams()[0]!.push(anEvent(1)));
    await waitFor(async () => expect(await shown()).toEqual(['line 1']));
    expect(screen.queryByText(/Reconnecting…/)).toBeNull();
    vi.useRealTimers();
  });

  it('scrolls the log to a Run step from its "log below" link (Issue #115)', async () => {
    const at = '2026-11-15T10:00:00.000Z';
    const run = aRun({
      state: 'waiting_for_operator',
      question: { text: 'And the schema name?' },
      messages: [
        { role: 'operator', kind: 'task', text: 'Add a store', at },
        { role: 'agent', kind: 'question', text: 'Which database?', at },
        { role: 'operator', kind: 'answer', text: 'PostgreSQL', at },
        { role: 'agent', kind: 'question', text: 'And the schema name?', at },
      ],
    });
    const api = fakeRunsApi([run]);
    const lines = (from: number) =>
      Array.from({ length: 60 }, (_, i) => anEvent(from + i, { stepIndex: from < 60 ? 1 : 2 }));
    api.storeEvents(
      run.id,
      anEvent(1, { kind: 'step_started', text: 'Run step 1 started' }),
      ...lines(2),
      anEvent(62, { kind: 'step_finished', text: 'Run step 1 finished: needs input' }),
      anEvent(63, { kind: 'step_started', stepIndex: 2, text: 'Run step 2 started' }),
      ...lines(64),
    );
    renderRun(run.id);
    await waitFor(() => expect(lineCount()).toBe('123 lines'));

    await userEvent.click(screen.getByRole('link', { name: 'Run step 2 · log below' }));

    // Step 2 starts at row 63 (index 62): the log shows it at the top, with keyboard focus.
    const element = await log();
    expect(element.scrollTop).toBe(62 * 20);
    expect(document.activeElement).toBe(element);
  });

  it('stops and offers a retry when the stream is refused', async () => {
    const run = aRun({ state: 'running', startedAt: '2026-11-15T10:00:05.000Z' });
    const api = fakeRunsApi([run]);
    api.respondNext('stream', 404, { status: 404, title: 'Run not found', detail: 'No run.' });
    renderRun(run.id);

    expect(await screen.findByText('Couldn’t load the log.')).toBeTruthy();
    expect(screen.queryByText(/Reconnecting…/)).toBeNull();
  });

  it('shows a cut entry and the "log truncated" notice', async () => {
    const run = aRun({ state: 'succeeded' });
    const api = fakeRunsApi([run]);
    api.storeEvents(
      run.id,
      anEvent(1, { text: 'x'.repeat(40), truncated: true }),
      anEvent(2, {
        kind: 'notice',
        text: "log truncated: the Run's log reached its size limit; later output is not stored",
      }),
    );
    renderRun(run.id);

    await waitFor(async () => expect(await shown()).toHaveLength(3));
    const rows = (await log()).querySelectorAll<HTMLElement>('[data-tone]');
    expect(rows[1]!.textContent).toContain('(cut: longer than an entry may be)');
    expect(rows[2]!.dataset.tone).toBe('warn');
    expect(rows[2]!.textContent).toContain('log truncated');
  });

  it('offers a retry when the stored log cannot be read', async () => {
    const run = aRun({ state: 'succeeded' });
    const api = fakeRunsApi([run]);
    api.storeEvents(run.id, anEvent(1, { text: 'after the retry' }));
    api.respondNext('events', 500, { status: 500, title: 'Error', detail: 'Boom.' });
    renderRun(run.id);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Couldn’t load the log.')).toBeTruthy();
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    await waitFor(async () => expect(await shown()).toEqual(['after the retry']));
    expect(screen.queryByText('Couldn’t load the log.')).toBeNull();
  });

  it('says what an empty log waits for', async () => {
    const run = aRun({ state: 'queued' });
    fakeRunsApi([run]);
    renderRun(run.id);

    expect(
      await screen.findByText('The log starts when an agent worker picks the run up.'),
    ).toBeTruthy();
  });
});
