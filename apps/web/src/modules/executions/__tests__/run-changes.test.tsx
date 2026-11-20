import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunDetail } from '..';
import { aRun, type FakeDiff, fakeRunsApi, problem, SHA } from './fake-runs-api';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

function renderRun(runId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RunDetail runId={runId} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  act(() => focusManager.setFocused(undefined));
});

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -10,3 +10,4 @@ export function app() {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = "<img src=x onerror=alert(1)>";',
  ' return a;',
  '',
].join('\n');

const DIFF: FakeDiff = {
  baseCommit: SHA,
  includesUnpushed: true,
  truncated: false,
  files: [
    { path: 'src/app.ts', status: 'modified', additions: 2, deletions: 1, patch: PATCH },
    {
      path: 'src/new-name.ts',
      previousPath: 'src/old-name.ts',
      status: 'renamed',
      additions: 0,
      deletions: 0,
      patch: 'diff --git a/src/old-name.ts b/src/new-name.ts\nsimilarity index 100%\n',
    },
    { path: 'logo.png', status: 'added', additions: 0, deletions: 0, binary: true },
    { path: 'data.json', status: 'added', additions: 9000, deletions: 0, tooLarge: true },
  ],
};

async function openChanges(
  runOverrides = {},
  diffs: Partial<Record<'run' | 'last', FakeDiff>> = {},
) {
  const run = aRun({ state: 'succeeded', ...runOverrides });
  const api = fakeRunsApi([run]);
  for (const [scope, diff] of Object.entries(diffs)) {
    api.setDiff(run.id, scope as 'run' | 'last', diff);
  }
  const user = userEvent.setup();
  const view = renderRun(run.id);
  await screen.findByRole('heading', { level: 1 });
  await user.click(screen.getByRole('tab', { name: 'Changes' }));
  return { run, api, user, ...view };
}

const section = (path: string) => screen.getByRole('region', { name: path });

describe('Run page: Changes tab', () => {
  it('sits beside the log; the log stays the first tab', async () => {
    const run = aRun({ state: 'succeeded' });
    fakeRunsApi([run]);
    renderRun(run.id);
    await screen.findByRole('heading', { level: 1 });

    expect(screen.getByRole('tab', { name: 'Log' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Changes' }).getAttribute('aria-selected')).toBe(
      'false',
    );
    expect(screen.getByRole('log', { name: 'Run log' })).toBeTruthy();
  });

  it('summarises the diff: files, lines, the start commit and whether it is all pushed', async () => {
    const { container } = await openChanges({}, { run: DIFF });

    expect(await screen.findByText('4 files changed')).toBeTruthy();
    expect(screen.getByText('From the start commit')).toBeTruthy();
    const commit = screen.getByText(SHA.slice(0, 12));
    expect(commit.className).toContain('font-mono');
    expect(commit.getAttribute('title')).toBe(SHA);
    expect(screen.getByText('Includes changes that are not pushed')).toBeTruthy();
    // The file list, each with its counts.
    const files = screen.getByRole('navigation', { name: 'Changed files' });
    expect(
      within(files)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([
      'src/app.tsModified,+2 lines added,−1 line removed',
      'src/new-name.tsRenamed,+0 lines added,−0 lines removed',
      'logo.pngAdded,+0 lines added,−0 lines removed',
      'data.jsonAdded,+9000 lines added,−0 lines removed',
    ]);
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows a file as a unified diff with line numbers, as plain text only', async () => {
    const { container } = await openChanges({}, { run: DIFF });

    const diff = await within(section('src/app.ts')).findByRole('region', {
      name: 'Diff of src/app.ts',
    });
    const rows = [...diff.querySelectorAll<HTMLElement>('[data-type]')].map((row) => [
      row.dataset.type,
      ...[...row.children].map((cell) => cell.textContent),
    ]);
    expect(rows).toEqual([
      ['hunk', '', '', '', '@@ -10,3 +10,4 @@ export function app() {'],
      ['ctx', '10', '10', '', 'const a = 1;'],
      ['del', '11', '', '−', 'const b = 2;'],
      ['add', '', '11', '+', 'const b = 3;'],
      ['add', '', '12', '+', 'const c = "<img src=x onerror=alert(1)>";'],
      ['ctx', '12', '13', '', 'return a;'],
    ]);
    // Nothing in the diff became markup.
    expect(container.querySelector('img')).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says why a file has no diff shown: renamed only, binary, too large', async () => {
    await openChanges({}, { run: DIFF });

    expect(
      await within(section('src/new-name.ts')).findByText(
        'No changes to the content (the file was renamed, or its mode changed).',
      ),
    ).toBeTruthy();
    expect(within(section('src/new-name.ts')).getByText('src/old-name.ts')).toBeTruthy();
    expect(
      within(section('logo.png')).getByText('Binary file: its content is not shown.'),
    ).toBeTruthy();
    expect(
      within(section('data.json')).getByText(
        'Too large to show: 9000 lines added, 0 lines removed.',
      ),
    ).toBeTruthy();
  });

  it('says when the diff reached its limit, and which files it left without content', async () => {
    await openChanges(
      {},
      {
        run: {
          ...DIFF,
          truncated: true,
          files: [{ path: 'later.ts', status: 'added', additions: 3, deletions: 0 }],
        },
      },
    );

    expect(await screen.findByText('Not every change is shown.')).toBeTruthy();
    expect(
      await within(section('later.ts')).findByText(
        'Not shown: the diff reached its size limit before this file.',
      ),
    ).toBeTruthy();
  });

  it('collapses the files beyond the first five; a collapsed file loads when it is opened', async () => {
    const files = Array.from({ length: 7 }, (_, i) => ({
      path: `file-${i + 1}.ts`,
      status: 'added' as const,
      additions: 1,
      deletions: 0,
      patch: `@@ -0,0 +1 @@\n+line of file ${i + 1}\n`,
    }));
    const { api, user } = await openChanges({}, { run: { ...DIFF, files } });

    await within(section('file-5.ts')).findByText('line of file 5');
    const toggle = within(section('file-6.ts')).getByRole('button', { name: 'file-6.ts' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(api.calls('diffFile').map((call) => call.query?.get('path'))).not.toContain('file-6.ts');

    await user.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(await within(section('file-6.ts')).findByText('line of file 6')).toBeTruthy();
    // Selecting a file in the list opens it too.
    await user.click(
      within(screen.getByRole('navigation', { name: 'Changed files' })).getByRole('button', {
        name: /^file-7\.ts/,
      }),
    );
    expect(await within(section('file-7.ts')).findByText('line of file 7')).toBeTruthy();
  });

  it('switches between the whole run and the changes since the previous result', async () => {
    const last: FakeDiff = {
      baseCommit: 'f'.repeat(40),
      includesUnpushed: true,
      truncated: false,
      files: [
        {
          path: 'only-new.ts',
          status: 'added',
          additions: 1,
          deletions: 0,
          patch: '@@ -0,0 +1 @@\n+new\n',
        },
      ],
    };
    const { user } = await openChanges({}, { run: DIFF, last });
    await screen.findByText('4 files changed');

    await user.click(screen.getByRole('button', { name: 'Since previous result' }));

    expect(await screen.findByText('1 file changed')).toBeTruthy();
    expect(screen.getByText('From the previous result at')).toBeTruthy();
    expect(screen.getByText('ffffffffffff')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Since previous result' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('links each file to the pull request on GitHub once its changes are pushed', async () => {
    const pullRequest = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
    await openChanges(
      { delivery: 'delivered', pullRequest },
      { run: { ...DIFF, includesUnpushed: false } },
    );

    expect(await screen.findByText('Every change here is pushed')).toBeTruthy();
    const link = within(section('src/app.ts')).getByRole('link', { name: /In pull request/ });
    expect(link.getAttribute('href')).toMatch(
      /^https:\/\/github\.com\/acme\/shop\/pull\/7\/files(#diff-[0-9a-f]{64})?$/,
    );
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('links nothing while changes are not pushed, or for a pull request off github.com', async () => {
    await openChanges(
      {
        delivery: 'delivered',
        pullRequest: { url: 'https://github.com/acme/shop/pull/7', number: 7 },
      },
      { run: DIFF },
    );
    await screen.findByText('4 files changed');
    expect(screen.queryByRole('link', { name: /In pull request/ })).toBeNull();
  });

  it('shows an empty state for a Run without changes', async () => {
    const { container } = await openChanges(
      {},
      { run: { ...DIFF, includesUnpushed: false, files: [] } },
    );

    expect(await screen.findByText('No changes')).toBeTruthy();
    expect(screen.getByText('The run has not changed any files.')).toBeTruthy();
    // Nothing to say about pushing when nothing changed.
    expect(screen.queryByText(/pushed/)).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says when there is no diff yet, and why for a finished Run', async () => {
    await openChanges({ state: 'running' });
    expect(await screen.findByText('No changes yet')).toBeTruthy();
    expect(
      screen.getByText('The changes appear when the agent reports its first result.'),
    ).toBeTruthy();
  });

  it('says no diff was recorded for a Run that ended without a result', async () => {
    await openChanges({ state: 'failed', failure: { code: 'agent_failed', detail: 'Broke.' } });
    expect(await screen.findByText('No changes recorded')).toBeTruthy();
  });

  it('shows the reason a diff could not be computed', async () => {
    const { container } = await openChanges(
      {},
      {
        run: {
          truncated: false,
          files: [],
          unavailableReason: 'The changes could not be computed (git add exited with code 128).',
        },
      },
    );

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Couldn't compute the changes")).toBeTruthy();
    expect(
      within(alert).getByText('The changes could not be computed (git add exited with code 128).'),
    ).toBeTruthy();
    expect(screen.queryByText(/pushed/)).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows a failed request with Retry, and loads the diff on retry', async () => {
    const run = aRun({ state: 'succeeded' });
    const api = fakeRunsApi([run]);
    api.setDiff(run.id, 'run', DIFF);
    api.respondNext('diff', 500, problem(500, 'Internal Server Error'));
    const user = userEvent.setup();
    renderRun(run.id);
    await screen.findByRole('heading', { level: 1 });
    await user.click(screen.getByRole('tab', { name: 'Changes' }));

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText('GET /api/runs/{runId}/diff · 500 Internal Server Error'),
    ).toBeTruthy();
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('4 files changed')).toBeTruthy();
  });

  it('on a phone the file list is a step before the diff, with a way back', async () => {
    const { user } = await openChanges({}, { run: DIFF });
    const list = screen.getByRole('navigation', { name: 'Changed files' });
    // Before a file is chosen, the diffs are hidden below the desktop width.
    expect(section('src/app.ts').className).toContain('max-md:hidden');
    expect(list.className).not.toContain('max-md:hidden');

    await user.click(within(list).getByRole('button', { name: /^logo\.png/ }));

    expect(list.className).toContain('max-md:hidden');
    expect(section('logo.png').className).not.toContain('max-md:hidden');
    expect(section('src/app.ts').className).toContain('max-md:hidden');
    await user.click(screen.getByRole('button', { name: 'All files' }));
    expect(list.className).not.toContain('max-md:hidden');
  });
});
