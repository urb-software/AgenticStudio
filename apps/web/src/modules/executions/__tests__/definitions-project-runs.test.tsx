import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuns } from '..';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const PROJECT_ID = '00000000-0000-4000-8000-0000000000d1';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Runs of the definitions Repository', () => {
  it('says plainly that it has no runs when the API refuses the list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              type: 'urn:agentic-studio:problem:definitions-project',
              title: 'Definitions Repository',
              status: 409,
              detail: 'The definitions Repository accepts no Run.',
              correlationId: '00000000-0000-4000-8000-000000000000',
              refused: 'run',
            }),
            { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
          ),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <ProjectRuns projectId={PROJECT_ID} repository="ready" />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole('heading', { name: 'The definitions Repository has no runs' }),
    ).toBeTruthy();
    expect(screen.queryByText(/Couldn't load the runs/)).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });
});
