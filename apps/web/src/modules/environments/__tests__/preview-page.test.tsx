import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster, toast } from '@/shared/ui/sonner';
import { PreviewPage } from '..';
import { fakePreviewApi, PROJECT_ID, problem } from './fake-preview-api';

// The Preview page with the generated client, the API wrapper and TanStack Query real and the API
// faked at `fetch`. Names are example.test ones.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SETTINGS = {
  composeFile: 'deploy/compose.yaml',
  service: 'web',
  port: 3000,
  updatedAt: '2026-11-23T10:00:00.000Z',
};

function renderPage(projectId = PROJECT_ID) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PreviewPage projectId={projectId} />
      <Toaster />
    </QueryClientProvider>,
  );
}

const field = (name: string) => screen.findByLabelText(name);

async function fill(label: string, value: string) {
  const input = await field(label);
  await userEvent.clear(input);
  if (value) await userEvent.type(input, value);
}

async function save() {
  await userEvent.click(await screen.findByRole('button', { name: 'Save Preview settings' }));
}

afterEach(() => {
  toast.dismiss();
  vi.unstubAllGlobals();
});

describe('Preview page', () => {
  it('says there is no Preview, how to set one up, and shows the hostname', async () => {
    fakePreviewApi();
    renderPage();

    expect(await screen.findByText('No Preview configured')).toBeTruthy();
    expect(screen.getByText(/put a Compose file in the repository/)).toBeTruthy();
    expect(screen.getByText('preview-3f2b8c1e4d5a.example.test')).toBeTruthy();
    expect(await field('Compose file')).toHaveProperty('value', 'compose.yaml');
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('shows the settings that are saved, and starts the form from them', async () => {
    fakePreviewApi({ settings: SETTINGS });
    renderPage();

    const region = await screen.findByRole('region', { name: 'Current Preview' });
    expect(within(region).getByText('deploy/compose.yaml')).toBeTruthy();
    expect(within(region).getByText('web')).toBeTruthy();
    expect(within(region).getByText('3000')).toBeTruthy();
    expect(await field('Compose file')).toHaveProperty('value', 'deploy/compose.yaml');
    expect(await field('Service')).toHaveProperty('value', 'web');
    expect(await field('Port')).toHaveProperty('value', '3000');
  });

  it('says why there is no hostname while no preview domain is configured', async () => {
    fakePreviewApi({ hostname: null });
    renderPage();

    expect(await screen.findByText('No hostname yet.')).toBeTruthy();
    expect(screen.getByText('STUDIO_PREVIEW_DOMAIN')).toBeTruthy();
  });

  it('turns the form off with the reason while the repository is not ready', async () => {
    fakePreviewApi({ repository: { ready: false, reason: 'repository_not_ready' } });
    renderPage();

    expect(await screen.findByText(/The repository is not ready/)).toBeTruthy();
    // The fieldset is disabled, which disables the controls it holds.
    expect((await field('Compose file')).matches(':disabled')).toBe(true);
    expect((await field('Service')).matches(':disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Save Preview settings' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('says there is no repository when the project has none', async () => {
    fakePreviewApi({ repository: { ready: false, reason: 'no_repository' } });
    renderPage();

    expect(await screen.findByText(/This project has no repository/)).toBeTruthy();
  });

  it('saves the three settings, then shows them and a toast', async () => {
    const api = fakePreviewApi();
    renderPage();

    await fill('Service', 'web');
    await fill('Port', '3000');
    await save();

    await waitFor(() =>
      expect(api.saves).toEqual([{ composeFile: 'compose.yaml', service: 'web', port: 3000 }]),
    );
    const region = await screen.findByRole('region', { name: 'Current Preview' });
    expect(await within(region).findByText('compose.yaml')).toBeTruthy();
    expect(await screen.findByText('Preview settings saved')).toBeTruthy();
    expect(screen.queryByText('No Preview configured')).toBeNull();
  });

  it('says which published ports were removed', async () => {
    const api = fakePreviewApi();
    renderPage();
    api.respondNextSave(200, {
      settings: {
        composeFile: 'compose.yaml',
        service: 'web',
        port: 80,
        updatedAt: SETTINGS.updatedAt,
      },
      hostname: 'preview-3f2b8c1e4d5a.example.test',
      repository: { ready: true },
      removedPorts: [{ service: 'web', place: 'services.web.ports[0]' }],
    });

    await fill('Service', 'web');
    await fill('Port', '80');
    await save();

    const list = await screen.findByRole('list', { name: 'Removed ports' });
    expect(within(list).getByText('services.web.ports[0]')).toBeTruthy();
    expect(screen.getByText('Published ports were removed.')).toBeTruthy();
  });

  it('shows every refusal with its place, and keeps the form for another try', async () => {
    const api = fakePreviewApi();
    renderPage();
    api.respondNextSave(
      422,
      problem(422, 'Preview settings refused', {
        refusals: [
          {
            code: 'privileged',
            place: 'services.web.privileged',
            message: 'A privileged container is not allowed.',
          },
          {
            code: 'docker_socket',
            place: 'services.web.volumes[0]',
            message: 'Mounting a Docker socket is not allowed.',
          },
        ],
      }),
    );

    await fill('Service', 'web');
    await fill('Port', '80');
    await save();

    const list = await screen.findByRole('list', { name: 'Refusals' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('services.web.privileged')).toBeTruthy();
    expect(within(items[0]!).getByText('A privileged container is not allowed.')).toBeTruthy();
    expect(within(items[1]!).getByText('services.web.volumes[0]')).toBeTruthy();
    expect(screen.getByText('The Preview settings were not saved.')).toBeTruthy();
    expect(await field('Service')).toHaveProperty('value', 'web');
    expect(screen.queryByText('Preview settings saved')).toBeNull();
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('shows a refusal at the Compose file, such as a file that is not there', async () => {
    const api = fakePreviewApi();
    renderPage();
    api.respondNextSave(
      422,
      problem(422, 'Preview settings refused', {
        refusals: [
          {
            code: 'compose_file_missing',
            place: 'composeFile',
            message: 'The Compose file is not in the Integration branch, or is not a regular file.',
          },
        ],
      }),
    );

    await fill('Service', 'web');
    await fill('Port', '80');
    await save();

    const list = await screen.findByRole('list', { name: 'Refusals' });
    expect(within(list).getByText('composeFile')).toBeTruthy();
    expect(within(list).getByText(/compose_file_missing/)).toBeTruthy();
  });

  it('checks the fields before it sends anything', async () => {
    const api = fakePreviewApi();
    renderPage();

    await fill('Compose file', '');
    await fill('Service', '-web');
    await fill('Port', '70000');
    await save();

    expect(await screen.findByText('Enter the path of the Compose file.')).toBeTruthy();
    expect(screen.getByText('Enter a service name from the Compose file, e.g. web.')).toBeTruthy();
    expect(screen.getByText('Enter a whole number from 1 to 65535.')).toBeTruthy();
    expect(api.saves).toEqual([]);
  });

  it('shows the API field errors of a request it refused', async () => {
    const api = fakePreviewApi();
    renderPage();
    api.respondNextSave(
      400,
      problem(400, 'Bad Request', { errors: [{ path: 'port', message: 'The API says no.' }] }),
    );

    await fill('Service', 'web');
    await fill('Port', '80');
    await save();

    expect(await screen.findByText('The API says no.')).toBeTruthy();
  });

  it('shows another refusal, such as a repository that stopped being ready, as a banner', async () => {
    const api = fakePreviewApi();
    renderPage();
    api.respondNextSave(409, problem(409, 'Repository not ready'));

    await fill('Service', 'web');
    await fill('Port', '80');
    await save();

    expect(await screen.findByText('Repository not ready')).toBeTruthy();
    expect(screen.getByText('Repository not ready (test)')).toBeTruthy();
  });

  it('asks before it removes the settings, and then shows none', async () => {
    const api = fakePreviewApi({ settings: SETTINGS });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove settings' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('heading', { name: 'Remove Preview settings' })).toBeTruthy();
    expect(api.removes).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove Preview settings' }));

    await waitFor(() => expect(api.removes).toHaveLength(1));
    expect(await screen.findByText('No Preview configured')).toBeTruthy();
    expect(await screen.findByText('Preview settings removed')).toBeTruthy();
  });

  it('keeps the settings when the confirmation is cancelled', async () => {
    const api = fakePreviewApi({ settings: SETTINGS });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove settings' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    );

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.removes).toHaveLength(0);
    expect(screen.getByText('deploy/compose.yaml')).toBeTruthy();
  });

  it('shows a refused removal in the dialog', async () => {
    const api = fakePreviewApi({ settings: SETTINGS });
    renderPage();
    api.respondNext(409, problem(409, 'Preview running'));

    await userEvent.click(await screen.findByRole('button', { name: 'Remove settings' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Remove Preview settings',
      }),
    );

    expect(
      await within(await screen.findByRole('alertdialog')).findByText('Preview running'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Current Preview', hidden: true })).getByText(
        'deploy/compose.yaml',
      ),
    ).toBeTruthy();
  });

  it('says the project is not found', async () => {
    fakePreviewApi();
    renderPage('00000000-0000-4000-8000-000000000000');

    expect(await screen.findByText('Project not found')).toBeTruthy();
  });
});
