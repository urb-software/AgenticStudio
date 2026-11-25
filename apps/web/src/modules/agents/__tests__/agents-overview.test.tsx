import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster, toast } from '@/shared/ui/sonner';
import { AgentsOverview } from '..';
import type { RepositoryOutput } from '../../../platform/api';
import { DEFINITIONS_PROJECT, fakeAgentsApi, problem } from './fake-agents-api';

// The Repository card has no navigation of its own; the composed screens may.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const URL = 'git@github.com:acme/agents.git';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const READY: RepositoryOutput = {
  state: 'ready',
  url: 'https://github.com/acme/agents.git',
  integrationBranch: 'main',
  hasClone: true,
  headSha: SHA,
  lastFetchedAt: '2026-11-13T10:00:00.000Z',
};

function renderAgents() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AgentsOverview />
      <Toaster />
    </QueryClientProvider>,
  );
}

const card = () => screen.getByRole('region', { name: 'Repository' });

afterEach(() => {
  act(() => {
    focusManager.setFocused(undefined);
    toast.dismiss();
  });
  vi.unstubAllGlobals();
});

describe('Agents page: nothing connected', () => {
  it('offers to connect the definitions Repository and has no axe violations', async () => {
    fakeAgentsApi(null);
    const { container } = renderAgents();

    expect(await screen.findByRole('heading', { level: 1, name: 'Agents' })).toBeTruthy();
    expect(
      await screen.findByRole('heading', { name: 'No definitions Repository connected' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Connect definitions Repository' }).dataset.variant,
    ).toBe('primary');
    await expect(container).toHaveNoAxeViolations();
  });

  it('creates the Project with kind definitions and continues into the connection steps', async () => {
    const api = fakeAgentsApi(null);
    renderAgents();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Connect definitions Repository' }),
    );

    expect(await screen.findByRole('region', { name: 'Repository' })).toBeTruthy();
    expect(await screen.findByText('Definitions Repository added. Connect it next.')).toBeTruthy();
    // Focus moves on to the next step instead of falling to the page.
    expect(document.activeElement).toBe(
      within(card()).getByRole('button', { name: 'Connect repository' }),
    );
    expect(api.calls().find((call) => call.method === 'POST')?.body).toEqual({
      name: DEFINITIONS_PROJECT.name,
      kind: 'definitions',
    });
    // The existing connection steps: the card's own "Connect repository".
    await userEvent.click(within(card()).getByRole('button', { name: 'Connect repository' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect repository' });
    await userEvent.type(within(dialog).getByLabelText('Repository URL'), URL);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect repository' }));
    await waitFor(() => expect(api.repository?.state).toBe('awaiting_key'));
    expect(await within(card()).findByText('Awaiting key')).toBeTruthy();
  });

  it('shows the API refusal when the Project cannot be created', async () => {
    const api = fakeAgentsApi(null);
    renderAgents();
    await screen.findByRole('button', { name: 'Connect definitions Repository' });
    api.respondNext(409, {
      ...problem(409, 'Definitions Repository exists'),
      type: 'urn:agentic-studio:problem:definitions-project-exists',
      detail: 'A definitions Repository is already connected. Disconnect it to connect another.',
    });

    await userEvent.click(screen.getByRole('button', { name: 'Connect definitions Repository' }));

    expect(await screen.findByText(/already connected/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Definitions Repository exists');
  });

  it('asks for another name when the name is taken, and creates with it', async () => {
    const api = fakeAgentsApi(null);
    renderAgents();
    await screen.findByRole('button', { name: 'Connect definitions Repository' });
    api.respondNext(409, {
      ...problem(409, 'Conflict'),
      detail: 'A project with this name already exists.',
    });

    await userEvent.click(screen.getByRole('button', { name: 'Connect definitions Repository' }));

    const field = await screen.findByLabelText<HTMLInputElement>('Project name');
    expect(field.value).toBe('Agent definitions');
    expect(document.activeElement).toBe(field);
    expect(screen.getByText(/already exists. Choose another name/)).toBeTruthy();
    await expect(document.body).toHaveNoAxeViolations();
    await userEvent.clear(field);
    await userEvent.type(field, 'Team agents');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('region', { name: 'Repository' })).toBeTruthy();
    expect(
      api
        .calls()
        .filter((call) => call.method === 'POST')
        .map((call) => call.body),
    ).toEqual([
      { name: 'Agent definitions', kind: 'definitions' },
      { name: 'Team agents', kind: 'definitions' },
    ]);
  });

  it('checks the name before sending and keeps the form for a name the API rejects', async () => {
    const api = fakeAgentsApi(null);
    renderAgents();
    await screen.findByRole('button', { name: 'Connect definitions Repository' });
    api.respondNext(409, { ...problem(409, 'Conflict') });
    await userEvent.click(screen.getByRole('button', { name: 'Connect definitions Repository' }));
    const field = await screen.findByLabelText<HTMLInputElement>('Project name');

    await userEvent.clear(field);
    await userEvent.type(field, '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Enter a project name.')).toBeTruthy();
    await userEvent.clear(field);
    await userEvent.click(field);
    await userEvent.paste('x'.repeat(101));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Use at most 100 characters.')).toBeTruthy();
    expect(api.calls().filter((call) => call.method === 'POST')).toHaveLength(1);

    // The API's own 400 on the name keeps the field, with its message.
    await userEvent.clear(field);
    await userEvent.type(field, 'Team agents');
    api.respondNext(400, {
      ...problem(400, 'Bad Request', { errors: [{ path: 'name', message: 'Not allowed.' }] }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Not allowed.')).toBeTruthy();
    expect(screen.getByLabelText('Project name')).toBeTruthy();
  });

  it('says so, with a Retry, when the page cannot be read', async () => {
    const api = fakeAgentsApi(null);
    api.respondNext(500, problem(500, 'Internal Server Error'));
    const { container } = renderAgents();

    expect(await screen.findByText(/GET \/api\/agents\/definitions-repository · 500/)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('button', { name: 'Connect definitions Repository' }),
    ).toBeTruthy();
  });
});

describe('Agents page: connected', () => {
  it('shows the state, the Integration branch, the last fetched commit and Fetch', async () => {
    fakeAgentsApi({ repository: READY });
    const { container } = renderAgents();

    await screen.findByRole('region', { name: 'Repository' });
    expect(await within(card()).findByText('Connected')).toBeTruthy();
    expect(within(card()).getByText('main')).toBeTruthy();
    expect(within(card()).getByText('0123456')).toBeTruthy();
    expect(within(card()).getByRole('button', { name: 'Fetch' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect definitions Repository' })).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('fetches the Integration branch', async () => {
    const api = fakeAgentsApi({ repository: READY });
    renderAgents();

    await userEvent.click(
      await within(await screen.findByRole('region', { name: 'Repository' })).findByRole('button', {
        name: 'Fetch',
      }),
    );

    await waitFor(() => expect(api.repository?.state).toBe('fetching'));
    expect(await within(card()).findByText('Fetching')).toBeTruthy();
  });

  it('continues the connection steps for a Project without a Repository yet', async () => {
    fakeAgentsApi({ repository: null });
    const { container } = renderAgents();

    expect(
      await within(await screen.findByRole('region', { name: 'Repository' })).findByRole('button', {
        name: 'Connect repository',
      }),
    ).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });
});
