import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster, toast } from '@/shared/ui/sonner';
import { AgentsOverview } from '..';
import type { AgentSummaryOutput, RepositoryOutput } from '../../../platform/api';
import {
  agentDetail,
  agentList,
  BASE_RULES,
  BUILT_INS,
  fakeAgentsApi,
  problem,
} from './fake-agents-api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SHA = '0123456789abcdef0123456789abcdef01234567';
const NEW_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
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
      code: 'provider_unknown',
      path: 'AGENT.md',
      key: 'provider',
      message: 'The provider is not one Studio knows.',
    },
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

afterEach(() => {
  act(() => {
    focusManager.setFocused(undefined);
    toast.dismiss();
  });
  vi.unstubAllGlobals();
});

describe('Agents page: the list', () => {
  it('lists agents with provider, model, Built in mark and the commit, without axe violations', async () => {
    fakeAgentsApi(
      { repository: READY },
      {
        list: agentList({ commit: SHA, repository: REPOSITORY, agents: [...BUILT_INS, REVIEWER] }),
      },
    );
    const { container } = renderAgents();

    const card = await screen.findByRole('region', { name: 'Agents' });
    expect(within(card).getByText('Read at commit')).toBeTruthy();
    expect(within(card).getByText('0123456')).toBeTruthy();
    const rows = within(card).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('default-claude-code')).toBeTruthy();
    expect(within(rows[0]!).getByText('Built in')).toBeTruthy();
    expect(within(rows[0]!).getByText('Claude Code')).toBeTruthy();
    expect(within(rows[1]!).getByText('Codex')).toBeTruthy();
    expect(within(rows[2]!).getByText('reviewer')).toBeTruthy();
    expect(within(rows[2]!).getByText('Reviews a change')).toBeTruthy();
    expect(within(rows[2]!).getByText('opus')).toBeTruthy();
    expect(within(rows[2]!).queryByText('Built in')).toBeNull();
    expect(within(card).queryByText('Not usable')).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('links each definitions agent to the editor on its AGENT.md, and no built-in agent', async () => {
    fakeAgentsApi(
      { repository: READY },
      {
        list: agentList({
          commit: SHA,
          repository: REPOSITORY,
          agents: [...BUILT_INS, REVIEWER, BROKEN],
        }),
      },
    );
    renderAgents();

    const card = await screen.findByRole('region', { name: 'Agents' });
    const links = within(card).getAllByRole('link', { name: /^Open in editor/ });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/agents/editor?path=agents%2Freviewer%2FAGENT.md',
      '/agents/editor?path=agents%2Fbroken%2FAGENT.md',
    ]);
  });

  it('marks an invalid agent Not usable, with each problem and its place', async () => {
    fakeAgentsApi(
      { repository: READY },
      { list: agentList({ commit: SHA, repository: REPOSITORY, agents: [...BUILT_INS, BROKEN] }) },
    );
    const { container } = renderAgents();

    const card = await screen.findByRole('region', { name: 'Agents' });
    const row = within(card).getAllByRole('listitem')[2]!;
    expect(within(row).getByText('Not usable')).toBeTruthy();
    expect(within(row).getByText('AGENT.md')).toBeTruthy();
    expect(within(row).getByText(/The provider is not one Studio knows/)).toBeTruthy();
    expect(within(row).getByText('provider')).toBeTruthy();
    expect(within(row).getByText('notes/big.txt')).toBeTruthy();
    expect(within(row).getByText(/larger than the limit/)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('keys rows by source and name when a refused folder shares a built-in name', async () => {
    const clash: AgentSummaryOutput = { ...BROKEN, name: 'default-codex' };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fakeAgentsApi(
      { repository: READY },
      { list: agentList({ commit: SHA, repository: REPOSITORY, agents: [...BUILT_INS, clash] }) },
    );
    renderAgents();

    const card = await screen.findByRole('region', { name: 'Agents' });
    expect(within(card).getAllByText('default-codex')).toHaveLength(2);
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
    errors.mockRestore();
  });

  it('says so when the list is truncated', async () => {
    fakeAgentsApi(
      { repository: READY },
      { list: agentList({ commit: SHA, repository: REPOSITORY, truncated: true }) },
    );
    const { container } = renderAgents();

    expect(await screen.findByText(/More agent folders exist than are listed/)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it("shows the Repository's note", async () => {
    fakeAgentsApi(
      { repository: { ...READY, state: 'failed' } },
      {
        list: agentList({
          commit: SHA,
          repository: {
            state: 'failed',
            note: 'The last fetch failed; these are the last known agents.',
          },
        }),
      },
    );
    const { container } = renderAgents();

    expect(await screen.findByText(/these are the last known agents/)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('gives the reason when nothing can be read', async () => {
    fakeAgentsApi({ repository: null }, { list: agentList() });
    const { container } = renderAgents();

    const card = await screen.findByRole('region', { name: 'Agents' });
    expect(within(card).getByText(/No definitions Repository is connected/)).toBeTruthy();
    expect(within(card).getByText('No commit read')).toBeTruthy();
    expect(within(card).getByText('default-claude-code')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says so, with a Retry, when the list cannot be read', async () => {
    const api = fakeAgentsApi({ repository: READY }, { list: agentList({ commit: SHA }) });
    api.failNextList(500, problem(500, 'Internal Server Error'));
    const { container } = renderAgents();

    expect(await screen.findByText(/GET \/api\/agents · 500/)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Agents' })).toBeTruthy();
  });
});

describe('Agents page: an agent', () => {
  it('shows instructions as plain text and the other files with their sizes', async () => {
    fakeAgentsApi(
      { repository: READY },
      {
        list: agentList({ commit: SHA, repository: REPOSITORY, agents: [...BUILT_INS, REVIEWER] }),
        details: {
          reviewer: agentDetail(REVIEWER, {
            instructions: 'Review the diff.\nBe brief.',
            files: [
              { path: 'AGENT.md', size: 120 },
              { path: 'checklist.md', size: 2048 },
            ],
          }),
        },
      },
    );
    const { container } = renderAgents();
    await screen.findByRole('region', { name: 'Agents' });

    await userEvent.click(screen.getByRole('button', { name: 'Show reviewer' }));

    const instructions = await screen.findByRole('region', { name: 'Instructions text' });
    expect(instructions.textContent).toBe('Review the diff.\nBe brief.');
    expect(instructions.className).toContain('whitespace-pre-wrap');
    expect(screen.getByText('checklist.md')).toBeTruthy();
    expect(screen.getByText('2 KiB')).toBeTruthy();
    expect(screen.getByText('120 B')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Hide reviewer' }).getAttribute('aria-expanded'),
    ).toBe('true');
    await expect(container).toHaveNoAxeViolations();
  });

  it('keeps <a> and <script> in instructions and base rules as visible text', async () => {
    const hostile =
      'See <a href="https://evil.example/x">here</a> <script>alert(1)</script> [md](https://evil.example)';
    fakeAgentsApi(
      { repository: READY },
      {
        list: agentList({
          commit: SHA,
          repository: REPOSITORY,
          agents: [...BUILT_INS, REVIEWER],
          baseRules: { version: 'v1', text: hostile },
        }),
        details: { reviewer: agentDetail(REVIEWER, { instructions: hostile }) },
      },
    );
    const { container } = renderAgents();
    await screen.findByRole('region', { name: 'Agents' });
    await userEvent.click(screen.getByRole('button', { name: 'Show reviewer' }));

    const instructions = await screen.findByRole('region', { name: 'Instructions text' });
    const rules = screen.getByRole('region', { name: 'Base rules text' });
    for (const element of [instructions, rules]) {
      expect(element.textContent).toBe(hostile);
      expect(element.querySelector('a, script, em, strong')).toBeNull();
    }
    expect(container.querySelector('a[href*="evil.example"]')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says a built-in agent has no instructions of its own', async () => {
    fakeAgentsApi(
      { repository: READY },
      {
        list: agentList({ commit: SHA, repository: REPOSITORY }),
        details: { 'default-codex': agentDetail(BUILT_INS[1]!) },
      },
    );
    const { container } = renderAgents();
    await screen.findByRole('region', { name: 'Agents' });

    await userEvent.click(screen.getByRole('button', { name: 'Show default-codex' }));

    expect(await screen.findByText(/no instructions of its own/)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says so, with a Retry, when the agent cannot be read', async () => {
    fakeAgentsApi(
      { repository: READY },
      {
        list: agentList({ commit: SHA, repository: REPOSITORY, agents: [...BUILT_INS, REVIEWER] }),
      },
    );
    const { container } = renderAgents();
    await screen.findByRole('region', { name: 'Agents' });

    await userEvent.click(screen.getByRole('button', { name: 'Show reviewer' }));

    expect(await screen.findByText('This agent is no longer in the Repository')).toBeTruthy();
    expect(screen.getByText('GET /api/agents/reviewer')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
    expect(within(agentsCard()).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('opens no files for a refused folder that shares a built-in name', async () => {
    const clash: AgentSummaryOutput = { ...BROKEN, name: 'default-codex' };
    fakeAgentsApi(
      { repository: READY },
      {
        list: agentList({ commit: SHA, repository: REPOSITORY, agents: [...BUILT_INS, clash] }),
        details: { 'default-codex': agentDetail(BUILT_INS[1]!) },
      },
    );
    renderAgents();
    await screen.findByRole('region', { name: 'Agents' });

    const buttons = screen.getAllByRole('button', { name: 'Show default-codex' });
    await userEvent.click(buttons[1]!);

    expect(await screen.findByText(/A built-in agent has this name/)).toBeTruthy();
  });
});

describe('Agents page: the base rules', () => {
  it('shows them as a separate read-only section that says instructions come after', async () => {
    fakeAgentsApi(
      { repository: READY },
      { list: agentList({ commit: SHA, repository: REPOSITORY }) },
    );
    const { container } = renderAgents();

    const section = await screen.findByRole('region', { name: 'Base rules' });
    expect(within(section).getByText(/instructions come after them/)).toBeTruthy();
    expect(within(section).getByText(/Read-only/)).toBeTruthy();
    expect(within(section).getByText('Version 2026-11-1')).toBeTruthy();
    expect(within(section).getByRole('region', { name: 'Base rules text' }).textContent).toBe(
      BASE_RULES.text,
    );
    expect(within(section).queryByRole('textbox')).toBeNull();
    expect(agentsCard().contains(section)).toBe(false);
    await expect(container).toHaveNoAxeViolations();
  });
});

describe('Agents page: refetching', () => {
  it('reads the list again on window focus', async () => {
    const api = fakeAgentsApi(
      { repository: READY },
      { list: agentList({ commit: SHA, repository: REPOSITORY }) },
    );
    renderAgents();
    await screen.findByRole('region', { name: 'Agents' });

    api.setAgents(
      agentList({ commit: NEW_SHA, repository: REPOSITORY, agents: [...BUILT_INS, REVIEWER] }),
    );
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    expect(await screen.findByText('reviewer')).toBeTruthy();
    expect(within(agentsCard()).getByText('fedcba9')).toBeTruthy();
  });

  it('reads the list again after a Fetch on the Repository card has ended', async () => {
    const api = fakeAgentsApi(
      { repository: READY },
      { list: agentList({ commit: SHA, repository: REPOSITORY }) },
    );
    renderAgents();
    const card = await screen.findByRole('region', { name: 'Repository' });
    await screen.findByRole('region', { name: 'Agents' });
    const listReads = () => api.calls().filter((call) => call.path === '/api/agents').length;
    const before = listReads();

    await userEvent.click(await within(card).findByRole('button', { name: 'Fetch' }));
    await waitFor(() => expect(api.repository?.state).toBe('fetching'));
    expect(await within(card).findByText('Fetching')).toBeTruthy();
    // The fetch brings a new commit and a new agent; the card's polling sees it end.
    api.setAgents(
      agentList({ commit: NEW_SHA, repository: REPOSITORY, agents: [...BUILT_INS, REVIEWER] }),
    );
    api.finishFetch(NEW_SHA);

    expect(await screen.findByText('reviewer', undefined, { timeout: 4000 })).toBeTruthy();
    expect(listReads()).toBeGreaterThan(before);
  });
});
