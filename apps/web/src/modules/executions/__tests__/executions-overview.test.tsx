import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ExecutionsOverview } from '..';
import { aRun, fakeRunsApi, OTHER_PROJECT_ID, problem, PROJECT } from './fake-runs-api';

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
  // The agent side's disk.
  describe('agent worker disk', () => {
    const GIB = 1024 ** 3;
    const disk = {
      workingCopiesBytes: 3.2 * GIB,
      cachesBytes: 1.5 * GIB,
      keptRuns: 4,
      freeBytes: 42 * GIB,
      totalBytes: 100 * GIB,
      minFreeBytes: 10 * GIB,
      low: false,
    };

    it('shows what the Working copies and caches take, the Runs kept and the free space', async () => {
      const api = fakeRunsApi([aRun()]);
      api.setAgentWorker({ connected: true, disk });
      const { container } = renderExecutions();

      const section = await screen.findByRole('region', { name: 'Agent worker disk' });
      expect(within(section).getByText('Working copies').nextSibling?.textContent).toBe('3.2 GiB');
      expect(within(section).getByText('Caches').nextSibling?.textContent).toBe('1.5 GiB');
      expect(within(section).getByText('Runs kept').nextSibling?.textContent).toBe('4');
      expect(within(section).getByText('Free').nextSibling?.textContent).toBe('42 GiB of 100 GiB');
      expect(screen.queryByText("The agent worker's disk is nearly full")).toBeNull();
      expect(await rows()).toHaveLength(1);
      await expect(container).toHaveNoAxeViolations();
    });

    it('warns when the free space is below the threshold, and says what that means', async () => {
      const api = fakeRunsApi([aRun()]);
      api.setAgentWorker({
        connected: true,
        disk: { ...disk, freeBytes: 6.5 * GIB, low: true },
      });
      const { container } = renderExecutions();

      const warning = (await screen.findByText("The agent worker's disk is nearly full")).closest(
        '[data-slot="banner"]',
      )!;
      expect(warning.getAttribute('role')).toBe('status');
      expect(warning.textContent).toContain('6.5 GiB are free, below the 10 GiB it keeps free');
      expect(warning.textContent).toContain('New runs are not prepared');
      await expect(container).toHaveNoAxeViolations();
    });

    it('says the sizes are lower bounds when some files could not be read', async () => {
      const api = fakeRunsApi([aRun()]);
      api.setAgentWorker({ connected: true, disk: { ...disk, partial: true } });
      renderExecutions();

      const section = await screen.findByRole('region', { name: 'Agent worker disk' });
      expect(within(section).getByText('Working copies').nextSibling?.textContent).toBe(
        'at least 3.2 GiB',
      );
      expect(section.textContent).toContain('sizes are lower bounds');
    });

    it('shows nothing while no worker is connected or it has not measured its disk yet', async () => {
      const api = fakeRunsApi([aRun()]);
      renderExecutions();
      await rows();
      expect(screen.queryByRole('region', { name: 'Agent worker disk' })).toBeNull();

      api.setAgentWorker({ connected: true });
      expect(screen.queryByRole('region', { name: 'Agent worker disk' })).toBeNull();
    });

    it('still lists the Runs when the worker status cannot be read', async () => {
      const api = fakeRunsApi([aRun({ task: 'Add pagination' })]);
      api.respondNext('agentWorker', 503, problem(503, 'Service Unavailable'));
      renderExecutions();

      expect((await rows())[0]!.textContent).toContain('Add pagination');
      expect(screen.queryByRole('region', { name: 'Agent worker disk' })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});
