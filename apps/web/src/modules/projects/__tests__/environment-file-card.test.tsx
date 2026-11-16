import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster, toast } from '@/shared/ui/sonner';
import { ProjectDetail } from '..';
import type { ProjectOutput } from '../../../platform/api';
import { fakeProjectApi, fieldProblem } from './fake-project-api';
import { problem } from './fake-projects-api';

// Issue #104: the project's Environment file card, on the project screen, with the generated
// client, the API wrapper and TanStack Query real and the API faked at `fetch`. Test values.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const PROJECT: ProjectOutput = {
  id: '00000000-0000-4000-8000-0000000000e1',
  name: 'Acme Shop',
  createdAt: '2026-11-12T09:00:00.000Z',
};
const CONTENT = 'DB_PASSWORD=test-only-pw-1\n';

let client: QueryClient;

/** Whether any entry of the mutation cache still holds `text` (in its variables or state). */
function mutationCacheHolds(text: string): boolean {
  return client
    .getMutationCache()
    .getAll()
    .some((mutation) => JSON.stringify(mutation.state).includes(text));
}

function renderDetail() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectDetail projectId={PROJECT.id} />
      <Toaster />
    </QueryClientProvider>,
  );
}

const card = () => screen.findByRole('region', { name: 'Environment file' });

async function openSetDialog(name = 'Set environment file') {
  await userEvent.click(await within(await card()).findByRole('button', { name }));
  return screen.findByRole('dialog');
}

afterEach(() => {
  toast.dismiss();
  vi.unstubAllGlobals();
});

describe('Environment file card', () => {
  it('offers to set a file when the project has none', async () => {
    fakeProjectApi(PROJECT);
    renderDetail();

    const region = await card();
    expect(await within(region).findByText('No environment file')).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Set environment file' })).toBeTruthy();
  });

  it('warns before saving, defaults the path to .env, and has no axe violations', async () => {
    fakeProjectApi(PROJECT);
    renderDetail();

    const dialog = await openSetDialog();

    expect(within(dialog).getByText('Use test values only.')).toBeTruthy();
    expect(
      within(dialog).getByText(/The agent can read this file and could print or send its content/),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText('Path in the repository')).toHaveProperty('value', '.env');
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('saves the file, then shows path, size and last change, never the content', async () => {
    const api = fakeProjectApi(PROJECT);
    renderDetail();
    const dialog = await openSetDialog();

    await userEvent.type(within(dialog).getByLabelText('Content'), CONTENT);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save environment file' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls('setEnvironmentFile')).toEqual([
      { route: 'setEnvironmentFile', body: { path: '.env', content: CONTENT } },
    ]);
    const region = await card();
    expect(await within(region).findByText('An environment file is set.')).toBeTruthy();
    expect(within(region).getByText('.env')).toBeTruthy();
    expect(within(region).getByText('27 bytes')).toBeTruthy();
    expect(within(region).getByText('Stored outside Git, write-only')).toBeTruthy();
    expect(document.body.textContent).not.toContain('test-only-pw-1');
    // Write-only in memory too: the save's request is not kept in the mutation cache.
    await waitFor(() => expect(mutationCacheHolds('test-only-pw-1')).toBe(false));
    expect(await screen.findByText('Environment file saved')).toBeTruthy();
    await expect(document.body).toHaveNoAxeViolations();
  });

  it("shows the API's reason for a refused path on the path field", async () => {
    const api = fakeProjectApi(PROJECT);
    api.respondNext(
      'setEnvironmentFile',
      422,
      fieldProblem(422, 'Unprocessable Entity', [
        { path: 'path', message: 'This path is tracked in the repository.' },
      ]),
    );
    renderDetail();
    const dialog = await openSetDialog();
    const path = within(dialog).getByLabelText('Path in the repository');
    await userEvent.clear(path);
    await userEvent.type(path, 'README.md');
    await userEvent.type(within(dialog).getByLabelText('Content'), CONTENT);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save environment file' }));

    expect(await within(dialog).findByText('This path is tracked in the repository.')).toBeTruthy();
    expect(path.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('refuses an empty path before sending', async () => {
    const api = fakeProjectApi(PROJECT);
    renderDetail();
    const dialog = await openSetDialog();
    await userEvent.clear(within(dialog).getByLabelText('Path in the repository'));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save environment file' }));

    expect(await within(dialog).findByText(/Enter a path inside the repository/)).toBeTruthy();
    expect(api.calls('setEnvironmentFile')).toEqual([]);
  });

  it('shows another refusal as a banner', async () => {
    const api = fakeProjectApi(PROJECT);
    api.respondNext('setEnvironmentFile', 500, problem(500, 'Internal Server Error'));
    renderDetail();
    const dialog = await openSetDialog();
    await userEvent.type(within(dialog).getByLabelText('Content'), CONTENT);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save environment file' }));

    expect(await within(dialog).findByRole('alert')).toBeTruthy();
  });

  it('replaces the file with a new content, keeping its path', async () => {
    const api = fakeProjectApi(PROJECT);
    api.state.environmentFile = {
      path: 'config/test.env',
      sizeBytes: 10,
      updatedAt: '2026-11-15T10:00:00.000Z',
    };
    renderDetail();
    const dialog = await openSetDialog('Replace');

    expect(within(dialog).getByRole('heading', { name: 'Replace environment file' })).toBeTruthy();
    expect(within(dialog).getByLabelText('Path in the repository')).toHaveProperty(
      'value',
      'config/test.env',
    );
    // Write-only: the content field starts empty.
    expect(within(dialog).getByLabelText('Content')).toHaveProperty('value', '');
    await userEvent.type(within(dialog).getByLabelText('Content'), 'A=test-only-new');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save environment file' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls('setEnvironmentFile').at(-1)?.body).toEqual({
      path: 'config/test.env',
      content: 'A=test-only-new',
    });
  });

  it('removes the file after a destructive confirm that says what is kept', async () => {
    const api = fakeProjectApi(PROJECT);
    api.state.environmentFile = {
      path: '.env',
      sizeBytes: 2048,
      updatedAt: '2026-11-15T10:00:00.000Z',
    };
    renderDetail();
    const region = await card();
    expect(await within(region).findByText('2.0 KiB')).toBeTruthy();

    await userEvent.click(within(region).getByRole('button', { name: 'Remove' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(
      within(confirm).getByText('Runs already started keep the copy they were given.'),
    ).toBeTruthy();
    await expect(document.body).toHaveNoAxeViolations();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove environment file' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.calls('removeEnvironmentFile')).toHaveLength(1);
    expect(await within(region).findByText('No environment file')).toBeTruthy();
    expect(await screen.findByText('Environment file removed')).toBeTruthy();
  });

  it('keeps no content in the mutation cache after a refused save and a cancelled dialog', async () => {
    const api = fakeProjectApi(PROJECT);
    api.respondNext('setEnvironmentFile', 500, problem(500, 'Internal Server Error'));
    renderDetail();
    const dialog = await openSetDialog();
    await userEvent.type(within(dialog).getByLabelText('Content'), 'A=test-only-refused');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save environment file' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(mutationCacheHolds('test-only-refused')).toBe(false));
    expect(document.body.textContent).not.toContain('test-only-refused');
  });

  it('keeps nothing of a dialog cancelled before saving', async () => {
    fakeProjectApi(PROJECT);
    renderDetail();
    const dialog = await openSetDialog();
    await userEvent.type(within(dialog).getByLabelText('Content'), 'A=test-only-typed');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mutationCacheHolds('test-only-typed')).toBe(false);
    // Opened again, the content field is empty.
    const reopened = await openSetDialog();
    expect(within(reopened).getByLabelText('Content')).toHaveProperty('value', '');
  });

  it('masks the content with hidden dots and a spoken "Hidden"', async () => {
    const api = fakeProjectApi(PROJECT);
    api.state.environmentFile = {
      path: '.env',
      sizeBytes: 5,
      updatedAt: '2026-11-15T10:00:00.000Z',
    };
    renderDetail();
    const region = await card();

    const hidden = await within(region).findByText('Hidden');
    expect(hidden.className).toContain('sr-only');
    expect(within(region).getByText('••••••••').getAttribute('aria-hidden')).toBe('true');
  });
});
