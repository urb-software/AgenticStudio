import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster, toast } from '@/shared/ui/sonner';
import { ProjectDetail } from '..';
import type { ProjectOutput } from '../../../platform/api';
import { fakeProjectApi, fieldProblem } from './fake-project-api';

// The project's Default agent card, on the project screen, with the generated client, the API
// wrapper and TanStack Query real and the API faked at `fetch`.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const PROJECT: ProjectOutput = {
  id: '00000000-0000-4000-8000-0000000000e3',
  name: 'Acme Shop',
  mergeMethod: 'squash',
  kind: 'code',
  defaultAgent: null,
  createdAt: '2026-11-12T09:00:00.000Z',
};

const REVIEWER = {
  name: 'reviewer',
  description: 'Reviews code',
  provider: 'codex',
  model: 'gpt-5',
  source: 'definitions',
} as const;

function renderDetail(project: ProjectOutput = PROJECT) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectDetail projectId={project.id} />
      <Toaster />
    </QueryClientProvider>,
  );
}

const card = () => screen.findByRole('region', { name: 'Default agent' });
const select = (region: HTMLElement) =>
  within(region).getByRole<HTMLSelectElement>('combobox', { name: 'Agent offered first' });
const saveButton = (region: HTMLElement) =>
  within(region).getByRole('button', { name: 'Save default agent' });

afterEach(() => {
  toast.dismiss();
  vi.unstubAllGlobals();
});

describe('Default agent card', () => {
  it('offers None and the usable agents, with None chosen when the project names no default, and nothing to save yet', async () => {
    const api = fakeProjectApi(PROJECT);
    api.state.runAgents.agents.push(REVIEWER);
    renderDetail();

    const region = await card();
    await waitFor(() => expect(within(select(region)).getAllByRole('option')).toHaveLength(4));

    expect(
      within(select(region))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'None (the built-in Default agent of the Provider)',
      'default-claude-code',
      'default-codex',
      'reviewer',
    ]);
    expect(select(region).value).toBe('');
    expect(saveButton(region)).toHaveProperty('disabled', true);
    await expect(document.body).toHaveNoAxeViolations();
  });

  it("shows the Project's own default agent chosen", async () => {
    const own = { ...PROJECT, defaultAgent: 'reviewer' };
    const api = fakeProjectApi(own);
    api.state.runAgents.agents.push(REVIEWER);
    renderDetail(own);

    const region = await card();

    await waitFor(() => expect(select(region).value).toBe('reviewer'));
  });

  it('saves the chosen agent and confirms it, then saves None', async () => {
    const api = fakeProjectApi(PROJECT);
    api.state.runAgents.agents.push(REVIEWER);
    renderDetail();
    const region = await card();
    await waitFor(() => expect(within(select(region)).getAllByRole('option')).toHaveLength(4));

    await userEvent.selectOptions(select(region), 'reviewer');
    await userEvent.click(saveButton(region));

    expect(await screen.findByText('Default agent saved')).toBeTruthy();
    expect(api.calls('setDefaultAgent')).toEqual([
      expect.objectContaining({ body: { agent: 'reviewer' } }),
    ]);
    await waitFor(() => expect(saveButton(region)).toHaveProperty('disabled', true));
    expect(select(region).value).toBe('reviewer');

    await userEvent.selectOptions(select(region), '');
    await userEvent.click(saveButton(region));

    await waitFor(() => expect(api.calls('setDefaultAgent')).toHaveLength(2));
    expect(api.calls('setDefaultAgent')[1]!.body).toEqual({ agent: null });
  });

  it('keeps a default that is no longer usable visible as such, with the reason, and lets it be changed', async () => {
    const reason =
      'The default agent "gone" is not usable: no agent has this name. The built-in Default agent is offered.';
    const own = { ...PROJECT, defaultAgent: 'gone' };
    const api = fakeProjectApi(own);
    api.state.runAgents.preselectedReason = reason;
    renderDetail(own);

    const region = await card();

    await waitFor(() => expect(select(region).value).toBe('gone'));
    expect(within(select(region)).getByRole('option', { name: 'gone (not usable)' })).toBeTruthy();
    expect(within(region).getByTestId('default-agent-reason').textContent).toBe(reason);
    await expect(document.body).toHaveNoAxeViolations();

    await userEvent.selectOptions(select(region), 'default-codex');
    await userEvent.click(saveButton(region));
    await waitFor(() =>
      expect(api.calls('setDefaultAgent')[0]!.body).toEqual({ agent: 'default-codex' }),
    );
  });

  it('shows the error of the API and keeps the choice', async () => {
    const api = fakeProjectApi(PROJECT);
    api.respondNext(
      'setDefaultAgent',
      404,
      fieldProblem(404, 'Project not found', undefined, 'No project has this id.'),
    );
    renderDetail();
    const region = await card();
    await waitFor(() => expect(within(select(region)).getAllByRole('option')).toHaveLength(3));

    await userEvent.selectOptions(select(region), 'default-codex');
    await userEvent.click(saveButton(region));

    expect(await within(region).findByText('No project has this id.')).toBeTruthy();
    expect(select(region).value).toBe('default-codex');
    expect(screen.queryByText('Default agent saved')).toBeNull();
  });

  it('says the agents could not be loaded and offers Try again', async () => {
    const api = fakeProjectApi(PROJECT);
    api.respondNext('runAgents', 503, fieldProblem(503, 'Service Unavailable', undefined));
    renderDetail();
    const region = await card();

    expect(await within(region).findByText("Couldn't load the agents.")).toBeTruthy();
    await expect(document.body).toHaveNoAxeViolations();
    await userEvent.click(within(region).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(select(region).value).toBe(''));
    expect(api.calls('runAgents')).toHaveLength(2);
  });

  it('is not offered for the definitions Project, which starts no Run', async () => {
    const definitions: ProjectOutput = { ...PROJECT, kind: 'definitions' };
    const api = fakeProjectApi(definitions);
    renderDetail(definitions);

    await screen.findByRole('heading', { level: 1, name: 'Acme Shop' });

    expect(screen.queryByRole('region', { name: 'Default agent' })).toBeNull();
    expect(api.calls('runAgents')).toHaveLength(0);
  });
});
