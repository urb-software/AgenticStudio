import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentsOverview } from '..';
import { fakeAgentsApi, problem } from './fake-agents-api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

function renderAgents() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AgentsOverview />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Agents page: the models of each Provider', () => {
  it('lists the allowed models of every Provider, as the Providers answer gives them', async () => {
    fakeAgentsApi(null);
    const { container } = renderAgents();

    const card = await screen.findByRole('region', { name: 'Models' });
    const claude = await within(card).findByRole('group', { name: 'Claude Code' });
    expect(
      within(claude)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['default', 'opus', 'sonnet', 'haiku']);
    const codex = within(card).getByRole('group', { name: 'Codex' });
    expect(
      within(codex)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['default', 'gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-luna']);
    expect(card.textContent).toContain('the CLI’s own default');
    // A model is listed even for a Provider that is switched off.
    await expect(container).toHaveNoAxeViolations();
  });

  it('says so, with the request in mono and a Retry, when the models cannot be read', async () => {
    const api = fakeAgentsApi(null);
    api.failNextProviders(503, problem(503, 'Service Unavailable'));
    renderAgents();

    const card = await screen.findByRole('region', { name: 'Models' });
    expect(
      await within(card).findByText('GET /api/providers · 503 Service Unavailable'),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Agents' })).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Retry' }));
    expect(await within(card).findByRole('group', { name: 'Claude Code' })).toBeTruthy();
  });
});
