import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster, toast } from '@/shared/ui/sonner';
import { AgentsOverview } from '..';
import type { AgentSummaryOutput, RepositoryOutput } from '../../../platform/api';
import { agentDetail, agentList, BUILT_INS, fakeAgentsApi, problem } from './fake-agents-api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SHA = '0123456789abcdef0123456789abcdef01234567';
const READY: RepositoryOutput = {
  state: 'ready',
  url: 'https://github.com/acme/agents.git',
  integrationBranch: 'main',
  hasClone: true,
  headSha: SHA,
  lastFetchedAt: '2026-11-13T10:00:00.000Z',
};
const REPOSITORY = { state: 'ready', note: null } as const;

const REVIEWER: AgentSummaryOutput = {
  name: 'reviewer',
  description: 'Reviews a change',
  provider: 'claude_code',
  model: 'opus',
  source: 'definitions',
  usable: true,
  skills: [],
  problems: [],
};
const BROKEN: AgentSummaryOutput = {
  name: 'broken',
  description: null,
  provider: null,
  model: null,
  source: 'definitions',
  usable: false,
  skills: [],
  problems: [
    {
      code: 'file_too_large',
      path: 'notes/big.txt',
      key: null,
      message: 'The file is larger than the limit.',
    },
  ],
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

const agentsCard = () => screen.getByRole('region', { name: 'Agents' });
const withAgents = (...agents: AgentSummaryOutput[]) =>
  agentList({ commit: SHA, repository: REPOSITORY, agents: [...BUILT_INS, ...agents] });
const rowOf = async (name: string) =>
  (await screen.findAllByRole('listitem')).find((item) => item.textContent?.includes(name))!;

afterEach(() => {
  act(() => {
    focusManager.setFocused(undefined);
    toast.dismiss();
  });
  vi.unstubAllGlobals();
});

describe('Agents page: no definitions Project yet', () => {
  it('lists the built-in agents and the base rules below the offer to connect', async () => {
    fakeAgentsApi(null, { list: agentList() });
    const { container } = renderAgents();

    expect(
      await screen.findByRole('heading', { name: 'No definitions Repository connected' }),
    ).toBeTruthy();
    const card = await screen.findByRole('region', { name: 'Agents' });
    expect(within(card).getByText('default-claude-code')).toBeTruthy();
    expect(within(card).getByText('default-codex')).toBeTruthy();
    expect(within(card).getAllByText('Built in')).toHaveLength(2);
    expect(within(card).getByText(/No definitions Repository is connected/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Base rules' })).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });
});

describe('Agents page: reading again when the Repository changes', () => {
  it('reads the list again when the first clone ends (connecting to ready)', async () => {
    const api = fakeAgentsApi(
      { repository: { ...READY, state: 'connecting', headSha: undefined } },
      {
        list: agentList({
          repository: { state: 'connecting', note: 'The Repository is being connected.' },
        }),
      },
    );
    renderAgents();
    expect(await screen.findByText(/The Repository is being connected/)).toBeTruthy();

    api.setAgents(withAgents(REVIEWER));
    api.finishFetch(SHA);

    expect(await screen.findByText('reviewer', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText(/The Repository is being connected/)).toBeNull();
  });

  it('reads the list again after a disconnect', async () => {
    const api = fakeAgentsApi({ repository: READY }, { list: withAgents(REVIEWER) });
    renderAgents();
    const card = await screen.findByRole('region', { name: 'Repository' });
    expect(await screen.findByText('reviewer')).toBeTruthy();

    await userEvent.click(await within(card).findByRole('button', { name: 'Disconnect' }));
    api.setAgents(agentList());
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Disconnect repository',
      }),
    );

    await waitFor(() => expect(screen.queryByText('reviewer')).toBeNull());
    expect(await screen.findByText(/No definitions Repository is connected/)).toBeTruthy();
  });
});

describe('Agents page: more states', () => {
  it('shows a loading state for the list', async () => {
    const api = fakeAgentsApi({ repository: READY }, { list: agentList({ commit: SHA }) });
    const release = api.hold('list');
    const { container } = renderAgents();

    const status = await screen.findByRole('status', { name: 'Loading the agents' });
    expect(status.getAttribute('aria-busy')).toBe('true');
    await expect(container).toHaveNoAxeViolations();
    release();
    expect(await screen.findByRole('region', { name: 'Agents' })).toBeTruthy();
  });

  it('shows a loading state for an agent', async () => {
    const api = fakeAgentsApi(
      { repository: READY },
      {
        list: withAgents(REVIEWER),
        details: { reviewer: agentDetail(REVIEWER, { instructions: 'Review.' }) },
      },
    );
    renderAgents();
    await screen.findByRole('region', { name: 'Agents' });
    const release = api.hold('detail');

    await userEvent.click(screen.getByRole('button', { name: 'Show reviewer' }));

    expect(await screen.findByRole('status', { name: 'Loading the agent' })).toBeTruthy();
    await expect(document.body).toHaveNoAxeViolations();
    release();
    expect(await screen.findByRole('region', { name: 'Instructions text' })).toBeTruthy();
  });

  it('says an agent cannot be loaded for a failure that is not a 404, and Retry reads it again', async () => {
    const api = fakeAgentsApi(
      { repository: READY },
      {
        list: withAgents(REVIEWER),
        details: { reviewer: agentDetail(REVIEWER, { instructions: 'Review.' }) },
      },
    );
    renderAgents();
    await screen.findByRole('region', { name: 'Agents' });
    api.failNextDetail(500, problem(500, 'Internal Server Error'));

    await userEvent.click(screen.getByRole('button', { name: 'Show reviewer' }));

    expect(await screen.findByText("Couldn't load the agent")).toBeTruthy();
    await expect(document.body).toHaveNoAxeViolations();
    await userEvent.click(within(agentsCard()).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Instructions text' })).toBeTruthy();
  });

  it('gives the reason when the Repository is not ready and has no Clone', async () => {
    fakeAgentsApi(
      { repository: { ...READY, state: 'failed', hasClone: false, headSha: undefined } },
      {
        list: agentList({
          repository: { state: 'failed', note: 'The first fetch failed; nothing was read.' },
        }),
      },
    );
    const { container } = renderAgents();

    const card = await screen.findByRole('region', { name: 'Agents' });
    expect(within(card).getByText('The first fetch failed; nothing was read.')).toBeTruthy();
    expect(within(card).getByText('No commit read')).toBeTruthy();
    expect(within(card).getAllByText('Built in')).toHaveLength(2);
    await expect(container).toHaveNoAxeViolations();
  });

  it('opens and hides an agent, and opening a second one closes the first', async () => {
    fakeAgentsApi(
      { repository: READY },
      {
        list: withAgents(REVIEWER),
        details: {
          reviewer: agentDetail(REVIEWER, { instructions: 'Review the diff.' }),
          'default-codex': agentDetail(BUILT_INS[1]!),
        },
      },
    );
    const { container } = renderAgents();
    await screen.findByRole('region', { name: 'Agents' });

    const show = screen.getByRole('button', { name: 'Show reviewer' });
    await userEvent.click(show);
    const instructions = await screen.findByRole('region', { name: 'Instructions text' });
    const controls = show.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls ?? '')?.contains(instructions)).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Show default-codex' }));
    expect(await screen.findByText(/no instructions of its own/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Instructions text' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Show reviewer' }).getAttribute('aria-expanded'),
    ).toBe('false');
    await expect(container).toHaveNoAxeViolations();

    await userEvent.click(screen.getByRole('button', { name: 'Hide default-codex' }));
    expect(screen.queryByText(/no instructions of its own/)).toBeNull();
  });

  it('says so when a usable agent has an empty body', async () => {
    fakeAgentsApi(
      { repository: READY },
      {
        list: withAgents(REVIEWER),
        details: { reviewer: agentDetail(REVIEWER, { instructions: '' }) },
      },
    );
    const { container } = renderAgents();
    await screen.findByRole('region', { name: 'Agents' });

    await userEvent.click(screen.getByRole('button', { name: 'Show reviewer' }));

    expect(await screen.findByText('The instructions of this agent are empty.')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says a not usable agent cannot be used and lists its problems, not "no instructions"', async () => {
    fakeAgentsApi(
      { repository: READY },
      { list: withAgents(BROKEN), details: { broken: agentDetail(BROKEN) } },
    );
    const { container } = renderAgents();
    await screen.findByRole('region', { name: 'Agents' });

    await userEvent.click(screen.getByRole('button', { name: 'Show broken' }));

    expect(
      await screen.findByText(/This agent cannot be used until its problems are fixed/),
    ).toBeTruthy();
    expect(screen.queryByText(/no instructions/i)).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('names the folder as the place of a problem with an empty path', async () => {
    const folderProblem: AgentSummaryOutput = {
      ...BROKEN,
      name: 'My_Agent',
      problems: [{ code: 'name_invalid', path: '', key: null, message: 'The name is not valid.' }],
    };
    fakeAgentsApi({ repository: READY }, { list: withAgents(folderProblem) });
    const { container } = renderAgents();

    const row = await rowOf('My_Agent');
    expect(within(row).getByText("the agent's folder")).toBeTruthy();
    expect(within(row).getByText(/The name is not valid/)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('opens no detail for a reserved name; its problems show inline', async () => {
    const reserved: AgentSummaryOutput = {
      ...BROKEN,
      name: 'definitions-repository',
      problems: [
        { code: 'name_reserved', path: '', key: null, message: 'The name is reserved by Studio.' },
      ],
    };
    fakeAgentsApi({ repository: READY }, { list: withAgents(reserved) });
    const { container } = renderAgents();

    const row = await rowOf('definitions-repository');
    expect(within(row).getByText('Not usable')).toBeTruthy();
    expect(within(row).getByText(/reserved by Studio/)).toBeTruthy();
    expect(within(row).queryByRole('button')).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('treats an answer without an agent as not found, never throwing', async () => {
    fakeAgentsApi(
      { repository: READY },
      {
        list: withAgents(REVIEWER),
        // Another route's answer: the unwrapped client does not check the shape.
        details: { reviewer: { project: null } as never },
      },
    );
    renderAgents();
    await screen.findByRole('region', { name: 'Agents' });

    await userEvent.click(screen.getByRole('button', { name: 'Show reviewer' }));

    expect(await screen.findByText('This agent is no longer in the Repository')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Agents' })).toBeTruthy();
  });
});
