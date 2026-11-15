import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ExecutionsOverview } from '..';
import { aRun, fakeRunsApi, OTHER_PROJECT_ID, problem, PROJECT } from './fake-runs-api';

// Executions page seam (Story #97): the public ExecutionsOverview of the executions module, with
// the generated client, the API wrapper and TanStack Query real, and the API faked at `fetch`.

function renderExecutions() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ExecutionsOverview />
    </QueryClientProvider>,
  );
}

async function rows() {
  const list = await screen.findByRole('list', { name: 'Runs' });
  return within(list).getAllByRole('listitem');
}

describe('Executions page', () => {
  it('shows a loading placeholder until the Runs arrive', async () => {
    fakeRunsApi([aRun()]);
    renderExecutions();

    expect(screen.getByRole('heading', { level: 1, name: 'Executions' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Loading runs' })).toBeTruthy();
    expect(await rows()).toHaveLength(1);
  });

  it('lists Runs across projects, newest first, with the same columns plus the project', async () => {
    fakeRunsApi([
      aRun({
        task: 'Add pagination',
        state: 'running',
        provider: 'codex',
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      }),
      aRun({ task: 'Fix the build', state: 'succeeded', projectId: OTHER_PROJECT_ID }),
    ]);
    const { container } = renderExecutions();

    const [first, second] = await rows();
    expect(within(first!).getByRole('link', { name: 'Add pagination' })).toBeTruthy();
    expect(within(first!).getByText('Running')).toBeTruthy();
    expect(within(first!).getByText('Codex')).toBeTruthy();
    expect(within(first!).getByText(PROJECT.name)).toBeTruthy();
    expect(within(first!).getByText('5m ago')).toBeTruthy();
    expect(within(second!).getByRole('link', { name: 'Fix the build' })).toBeTruthy();
    expect(within(second!).getByText('Succeeded')).toBeTruthy();
    expect(within(second!).getByText('Unknown project')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows an empty state that leads to the projects, where Runs start', async () => {
    fakeRunsApi([]);
    renderExecutions();

    expect(await screen.findByRole('heading', { name: 'No runs yet' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Projects' }).getAttribute('href')).toBe(
      '/projects',
    );
  });

  it('shows the failed request in mono with Retry, which recovers', async () => {
    const api = fakeRunsApi([aRun({ task: 'Add pagination' })]);
    api.respondNext('runs', 503, problem(503, 'Service Unavailable'));
    renderExecutions();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('GET /api/runs · 503 Service Unavailable')).toBeTruthy();
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect((await rows())[0]!.textContent).toContain('Add pagination');
  });

  it('still lists the Runs when the project names cannot be read', async () => {
    const api = fakeRunsApi([aRun({ task: 'Add pagination' })]);
    api.respondNext('projects', 503, problem(503, 'Service Unavailable'));
    renderExecutions();

    const [row] = await rows();
    expect(within(row!).getByText('Unknown project')).toBeTruthy();
  });
});
