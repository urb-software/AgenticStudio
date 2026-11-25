import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewPage } from '..';
import { fakePreviewApi, PROJECT_ID } from './fake-preview-api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Preview of the definitions Repository', () => {
  it('says up front that it has no Preview, without the settings form or the build', async () => {
    fakePreviewApi({ kind: 'definitions' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <PreviewPage projectId={PROJECT_ID} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole('heading', { name: 'The definitions Repository has no Preview' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save Preview settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Build/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reset/ })).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });
});
