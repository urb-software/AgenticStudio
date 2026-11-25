import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewPage } from '..';
import { PROJECT_ID } from './fake-preview-api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Preview of the definitions Repository', () => {
  it('says plainly that it has no Preview when the API refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              type: 'urn:agentic-studio:problem:definitions-project',
              title: 'Definitions Repository',
              status: 409,
              detail:
                'The definitions Repository accepts no Preview settings, build, stop or reset.',
              correlationId: '00000000-0000-4000-8000-000000000000',
              refused: 'preview',
            }),
            { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
          ),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <PreviewPage projectId={PROJECT_ID} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole('heading', { name: 'The definitions Repository has no Preview' }),
    ).toBeTruthy();
    expect(screen.queryByText(/Couldn't load the Preview/)).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });
});
