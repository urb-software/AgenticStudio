import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateProjectForm, ProjectList } from '..';
import type { ProjectOutput } from '../../../platform/api';
import { fakeProjectsApi, problem } from './fake-projects-api';

// Story #16 UI seam: the public components of the projects module, with the generated
// client, the API wrapper and TanStack Query all real, and the API faked at `fetch`.

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

function renderProjectsPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CreateProjectForm />
      <ProjectList />
    </QueryClientProvider>,
  );
}

const nameInput = () => screen.getByLabelText<HTMLInputElement>('Project name');

function submitName(name: string) {
  fireEvent.change(nameInput(), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
}

async function listedNames(): Promise<string[]> {
  const list = await screen.findByRole('list', { name: 'Projects' });
  return within(list)
    .getAllByRole('listitem')
    .map((item) => within(item).getByRole('heading').textContent ?? '');
}

async function expectFieldError(message: string) {
  const error = await screen.findByText(message);
  expect(nameInput().getAttribute('aria-invalid')).toBe('true');
  expect(nameInput().getAttribute('aria-describedby')).toBe(error.id);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('project list', () => {
  it('shows an explicit empty state when there are no projects', async () => {
    fakeProjectsApi([]);

    renderProjectsPage();

    expect(await screen.findByText(/no projects yet/i)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Projects' })).toBeNull();
  });

  it('lists projects in the order the API returns them (newest first)', async () => {
    fakeProjectsApi([BETA, ALPHA]);

    renderProjectsPage();

    expect(await listedNames()).toEqual(['Beta', 'Alpha']);
  });

  it('shows an error when the list cannot be loaded', async () => {
    const api = fakeProjectsApi();
    api.respondNext('GET', 500, problem(500, 'Internal Server Error'));

    renderProjectsPage();

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not load projects/i);
  });
});

describe('create project form', () => {
  it('adds the new project to the list without a reload', async () => {
    const api = fakeProjectsApi([ALPHA]);
    renderProjectsPage();
    expect(await listedNames()).toEqual(['Alpha']);

    submitName('Gamma');

    await waitFor(async () => expect(await listedNames()).toEqual(['Gamma', 'Alpha']));
    expect(api.calls('POST')).toEqual([{ method: 'POST', body: { name: 'Gamma' } }]);
    expect(nameInput().value).toBe('');
  });

  it('requires a name before calling the API', async () => {
    const api = fakeProjectsApi();
    renderProjectsPage();

    submitName('');

    await expectFieldError('Enter a project name.');
    expect(api.calls('POST')).toEqual([]);
  });

  it('rejects a name over 100 characters before calling the API', async () => {
    const api = fakeProjectsApi();
    renderProjectsPage();

    submitName('x'.repeat(101));

    await expectFieldError('Use at most 100 characters.');
    expect(api.calls('POST')).toEqual([]);
  });

  it('shows the field error of a 400 response next to the name field', async () => {
    const api = fakeProjectsApi();
    api.respondNext(
      'POST',
      400,
      problem(400, 'Bad Request', [{ path: 'name', message: 'Enter a project name.' }]),
    );
    renderProjectsPage();

    submitName('   ');

    await expectFieldError('Enter a project name.');
  });

  it('shows the field error of a 409 (duplicate name) next to the name field', async () => {
    const api = fakeProjectsApi([ALPHA]);
    api.respondNext(
      'POST',
      409,
      problem(409, 'Conflict', [
        { path: 'name', message: 'A project with this name already exists.' },
      ]),
    );
    renderProjectsPage();

    submitName('alpha');

    await expectFieldError('A project with this name already exists.');
    expect(nameInput().value).toBe('alpha');
    expect(await listedNames()).toEqual(['Alpha']);
  });

  it('shows a form error when the API fails without field errors', async () => {
    const api = fakeProjectsApi();
    api.respondNext('POST', 500, problem(500, 'Internal Server Error'));
    renderProjectsPage();

    submitName('Delta');

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not create the project/i);
    expect(nameInput().getAttribute('aria-invalid')).not.toBe('true');
  });
});
