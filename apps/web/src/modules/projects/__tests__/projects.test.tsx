import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster, toast } from '@/shared/ui/sonner';
import { ProjectsOverview } from '..';
import type { ProjectOutput } from '../../../platform/api';
import { fakeProjectsApi, problem } from './fake-projects-api';

// Projects UI seam (Story #16, restyled in #44): the public ProjectsOverview of the projects
// module, with the generated client, the API wrapper and TanStack Query all real, and the API
// faked at `fetch`. The Toaster is mounted as the root layout mounts it.

const ALPHA: ProjectOutput = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Alpha',
  createdAt: '2026-11-12T09:00:00.000Z',
};
const BETA: ProjectOutput = {
  id: '00000000-0000-4000-8000-0000000000b2',
  name: 'Beta',
  createdAt: '2026-11-12T10:00:00.000Z',
};

function renderProjects() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectsOverview />
      <Toaster />
    </QueryClientProvider>,
  );
}

const dialog = () => screen.getByRole('dialog', { name: 'New project' });
const nameInput = () => within(dialog()).getByLabelText<HTMLInputElement>('Project name');

async function openDialog() {
  await userEvent.click(screen.getByRole('button', { name: 'New project' }));
  return dialog();
}

async function submitName(name: string) {
  await userEvent.clear(nameInput());
  if (name) {
    // `paste` keeps runs of whitespace and astral characters exactly as given.
    await userEvent.click(nameInput());
    await userEvent.paste(name);
  }
  await userEvent.click(within(dialog()).getByRole('button', { name: 'Create project' }));
}

async function listedNames(): Promise<string[]> {
  const list = await screen.findByRole('list', { name: 'Projects' });
  return within(list)
    .getAllByRole('listitem')
    .map((item) => within(item).getByRole('heading').textContent ?? '');
}

/** The listed names while the modal dialog hides the page from the accessibility tree. */
function namesBehindDialog(): string[] {
  return [...document.querySelectorAll('ul[aria-label="Projects"] h2')].map(
    (heading) => heading.textContent ?? '',
  );
}

async function expectFieldError(message: string) {
  const error = await within(dialog()).findByText(message);
  expect(nameInput().getAttribute('aria-invalid')).toBe('true');
  expect(nameInput().getAttribute('aria-describedby')).toContain(error.id);
}

/**
 * Holds every POST (after the fake API has recorded and stored it) until `release()`,
 * which answers them all with 201.
 */
function holdPosts(): () => void {
  const held: { resolve: (response: Response) => void; answer: Promise<Response> }[] = [];
  const fetch = vi.mocked(globalThis.fetch);
  const answer = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (input) => {
    const request = input as Request;
    if (request.method !== 'POST') return answer(request);
    const created = answer(request.clone()); // records and stores the project
    return new Promise<Response>((resolve) => held.push({ resolve, answer: created }));
  });
  return () => {
    for (const { resolve, answer: created } of held.splice(0)) {
      void created.then(resolve);
    }
  };
}

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('projects page header', () => {
  it('shows the Projects heading with a primary New project action', async () => {
    fakeProjectsApi([ALPHA]);
    const { container } = renderProjects();

    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeTruthy();
    const action = screen.getByRole('button', { name: 'New project' });
    expect(action.dataset.variant).toBe('primary');
    await listedNames();
    await expect(container).toHaveNoAxeViolations();
  });
});

describe('project list states', () => {
  it('loading: shows skeleton rows while the list loads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const { container } = renderProjects();

    const loading = screen.getByRole('status', { name: 'Loading projects' });
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole('list', { name: 'Projects' })).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('empty: shows the empty state with a Create project action that opens the dialog', async () => {
    fakeProjectsApi([]);
    const { container } = renderProjects();

    const empty = await screen.findByRole('heading', { name: 'Create your first project' });
    expect(screen.queryByRole('list', { name: 'Projects' })).toBeNull();
    await expect(container).toHaveNoAxeViolations();

    const action = within(empty.parentElement!).getByRole('button', { name: 'Create project' });
    expect(action.dataset.variant).toBe('primary');
    await userEvent.click(action);
    expect(dialog()).toBeTruthy();
  });

  it('error: shows the failed request in mono and retries it', async () => {
    const api = fakeProjectsApi([ALPHA]);
    api.respondNext('GET', 500, problem(500, 'Internal Server Error'));
    const { container } = renderProjects();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('heading').textContent).toBe("Couldn't load projects");
    const request = within(alert).getByText('GET /api/projects · 500 Internal Server Error');
    expect(request.className).toContain('font-mono');
    // Never the response body.
    expect(alert.textContent).not.toContain('(test)');
    expect(screen.queryByText(/reload the page/i)).toBeNull();
    await expect(container).toHaveNoAxeViolations();

    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await listedNames()).toEqual(['Alpha']);
    expect(api.calls('GET')).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('error: stays in the error state when Retry fails again, and Retry still works', async () => {
    const api = fakeProjectsApi([ALPHA]);
    api.respondNext('GET', 503, problem(503, 'Service Unavailable'));
    api.respondNext('GET', 500, problem(500, 'Internal Server Error'));
    renderProjects();
    await screen.findByText('GET /api/projects · 503 Service Unavailable');

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('GET /api/projects · 500 Internal Server Error')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(api.calls('GET')).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await listedNames()).toEqual(['Alpha']);
    expect(api.calls('GET')).toHaveLength(3);
  });

  it('error: shows the status alone when the response has no problem details', async () => {
    const api = fakeProjectsApi();
    api.respondNext('GET', 502, 'Bad gateway');
    renderProjects();

    expect(await screen.findByText('GET /api/projects · 502')).toBeTruthy();
  });

  it('error: shows the request alone when the API cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    renderProjects();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('GET /api/projects')).toBeTruthy();
  });

  it('data: each project card links to its project screen (#60)', async () => {
    fakeProjectsApi([BETA, ALPHA]);
    const { container } = renderProjects();

    const list = await screen.findByRole('list', { name: 'Projects' });
    expect(
      within(list)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['Beta', `/projects/${BETA.id}`],
      ['Alpha', `/projects/${ALPHA.id}`],
    ]);
    await expect(container).toHaveNoAxeViolations();
  });

  it('data: lists project cards newest first with a relative created time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T12:00:00.000Z'));
    fakeProjectsApi([BETA, ALPHA]);
    const { container } = renderProjects();

    expect(await listedNames()).toEqual(['Beta', 'Alpha']);
    const [beta, alpha] = within(screen.getByRole('list', { name: 'Projects' })).getAllByRole(
      'listitem',
    );
    expect(beta!.textContent).toContain('Created 2h ago');
    expect(alpha!.textContent).toContain('Created 3h ago');
    const time = alpha!.querySelector('time');
    expect(time?.getAttribute('dateTime')).toBe('2026-11-12T09:00:00.000Z');
    expect(time?.getAttribute('title')).toMatch(/2026/);
    await expect(container).toHaveNoAxeViolations();
  });
});

describe('new project dialog', () => {
  it('opens from the header, focuses the name field and has no axe violations', async () => {
    fakeProjectsApi([ALPHA]);
    renderProjects();
    await listedNames();

    await openDialog();

    expect(document.activeElement).toBe(nameInput());
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('creates the project: closes, updates the list and confirms with a toast', async () => {
    const api = fakeProjectsApi([ALPHA]);
    renderProjects();
    expect(await listedNames()).toEqual(['Alpha']);
    await openDialog();

    await submitName('Gamma');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await listedNames()).toEqual(['Gamma', 'Alpha']);
    expect(api.calls('POST')).toEqual([{ method: 'POST', body: { name: 'Gamma' } }]);
    expect(await screen.findByText('Project created')).toBeTruthy();
  });

  it('starts empty again after a project was created', async () => {
    fakeProjectsApi([]);
    renderProjects();
    await openDialog();
    await submitName('Gamma');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await openDialog();

    expect(nameInput().value).toBe('');
  });

  it('closes with Cancel and Esc, and reopens without the old value or errors', async () => {
    const api = fakeProjectsApi();
    renderProjects();
    await openDialog();
    await submitName('');
    await expectFieldError('Enter a project name.');

    await userEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await openDialog();
    expect(nameInput().value).toBe('');
    expect(within(dialog()).queryByText('Enter a project name.')).toBeNull();
    await userEvent.type(nameInput(), 'Draft');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.calls('POST')).toEqual([]);
  });

  it('stays open while the project is being created', async () => {
    const api = fakeProjectsApi();
    const release = holdPosts();
    renderProjects();
    await openDialog();

    await submitName('Gamma');

    const pending = within(dialog()).getByRole<HTMLButtonElement>('button', { name: 'Creating…' });
    expect(pending.disabled).toBe(true);
    expect(nameInput().readOnly).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(dialog()).toBeTruthy();
    expect(api.calls('POST')).toHaveLength(1);

    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('cannot be submitted twice while the project is being created', async () => {
    const api = fakeProjectsApi();
    const release = holdPosts();
    renderProjects();
    await openDialog();

    await submitName('Gamma');
    const pending = within(dialog()).getByRole<HTMLButtonElement>('button', { name: 'Creating…' });
    await userEvent.click(pending);
    await userEvent.type(nameInput(), '{Enter}');
    act(() => pending.form?.requestSubmit());

    expect(api.calls('POST')).toHaveLength(1);
    // Still pending: the ignored submits do not end the pending state.
    await act(async () => {});
    expect(within(dialog()).getByRole('button', { name: 'Creating…' })).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls('POST')).toHaveLength(1);
    expect(await listedNames()).toEqual(['Gamma']);
  });

  it('requires a name before calling the API', async () => {
    const api = fakeProjectsApi();
    renderProjects();
    await openDialog();

    await submitName('');

    await expectFieldError('Enter a project name.');
    expect(api.calls('POST')).toEqual([]);
  });

  it('rejects a name over 100 characters before calling the API', async () => {
    const api = fakeProjectsApi();
    renderProjects();
    await openDialog();

    await submitName('x'.repeat(101));

    await expectFieldError('Use at most 100 characters.');
    expect(api.calls('POST')).toEqual([]);
  });

  it('measures the length hint after whitespace normalization, as the API does', async () => {
    const api = fakeProjectsApi();
    renderProjects();
    await openDialog();

    await submitName(`   ${'a'.repeat(50)}      ${'b'.repeat(49)}  `);

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect(screen.queryByText('Use at most 100 characters.')).toBeNull();
  });

  it('counts the length in code points: 100 astral characters pass the hint', async () => {
    const api = fakeProjectsApi();
    renderProjects();
    await openDialog();

    await submitName('\u{1F600}'.repeat(100));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect(screen.queryByText('Use at most 100 characters.')).toBeNull();
  });

  it('counts the length in code points: 101 astral characters fail the hint', async () => {
    const api = fakeProjectsApi();
    renderProjects();
    await openDialog();

    await submitName('\u{1F600}'.repeat(101));

    await expectFieldError('Use at most 100 characters.');
    expect(api.calls('POST')).toEqual([]);
  });

  it('measures the length hint after NFC normalization, as the API does', async () => {
    const api = fakeProjectsApi();
    renderProjects();
    await openDialog();

    // 100 characters written in NFD (e + combining accent): 200 code points before NFC.
    await submitName('é'.repeat(100));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect(screen.queryByText('Use at most 100 characters.')).toBeNull();
  });

  it('shows the field error of a 400 response next to the name field', async () => {
    const api = fakeProjectsApi();
    api.respondNext(
      'POST',
      400,
      problem(400, 'Bad Request', [{ path: 'name', message: 'Enter a project name.' }]),
    );
    renderProjects();
    await openDialog();

    await submitName('   ');

    await expectFieldError('Enter a project name.');
  });

  it('keeps the dialog open with the field error of a 409 (duplicate name)', async () => {
    const api = fakeProjectsApi([ALPHA]);
    api.respondNext(
      'POST',
      409,
      problem(409, 'Conflict', [
        { path: 'name', message: 'A project with this name already exists.' },
      ]),
    );
    renderProjects();
    await openDialog();

    await submitName('alpha');

    await expectFieldError('A project with this name already exists.');
    expect(nameInput().value).toBe('alpha');
    expect(namesBehindDialog()).toEqual(['Alpha']);
    expect(screen.queryByText('Project created')).toBeNull();
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('keeps the dialog open with the server error: title in bold, then the detail', async () => {
    const api = fakeProjectsApi();
    api.respondNext('POST', 500, problem(500, 'Internal Server Error'));
    renderProjects();
    await openDialog();

    await submitName('Delta');

    const alert = await within(dialog()).findByRole('alert');
    expect(alert.querySelector('b')?.textContent?.trim()).toBe('Internal Server Error');
    expect(alert.textContent).toContain('Internal Server Error (test)');
    expect(nameInput().getAttribute('aria-invalid')).not.toBe('true');
    expect(nameInput().value).toBe('Delta');
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('keeps the generic copy under the title when the problem has an empty detail', async () => {
    const api = fakeProjectsApi();
    api.respondNext('POST', 503, { ...problem(503, 'Service Unavailable'), detail: '' });
    renderProjects();
    await openDialog();

    await submitName('Delta');

    const alert = await within(dialog()).findByRole('alert');
    expect(alert.querySelector('b')?.textContent?.trim()).toBe('Service Unavailable');
    expect(alert.textContent).toContain('Could not create the project. Try again.');
  });

  it('keeps the dialog open with a generic error when the response has no problem details', async () => {
    const api = fakeProjectsApi();
    api.respondNext('POST', 502, 'Bad gateway');
    renderProjects();
    await openDialog();

    await submitName('Delta');

    expect((await within(dialog()).findByRole('alert')).textContent).toBe(
      'Could not create the project. Try again.',
    );
  });
});
