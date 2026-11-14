import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectOutput, RepositoryOutput } from '../../../platform/api';
import { DisconnectRepositoryDialog } from '../features/disconnect-repository/disconnect-repository-dialog';
import { fakeProjectApi } from './fake-project-api';

// The Disconnect repository dialog on its own, with the generated client, the API wrapper and
// TanStack Query real and the API faked at `fetch`: how often it asks its owner to close (#72).

const PROJECT: ProjectOutput = {
  id: '00000000-0000-4000-8000-0000000000b2',
  name: 'Acme Shop',
  createdAt: '2026-11-12T09:00:00.000Z',
};
const READY: RepositoryOutput = {
  state: 'ready',
  url: 'https://github.com/acme/shop.git',
  integrationBranch: 'dev',
  hasClone: true,
};

function renderDialog() {
  const onOpenChange = vi.fn();
  const onDisconnected = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DisconnectRepositoryDialog
        projectId={PROJECT.id}
        url={READY.url}
        open
        onOpenChange={onOpenChange}
        onDisconnected={onDisconnected}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange, onDisconnected };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Disconnect repository dialog', () => {
  it('on a 204: confirms once and asks to close exactly once', async () => {
    fakeProjectApi(PROJECT, READY);
    const { onOpenChange, onDisconnected } = renderDialog();

    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Disconnect repository',
      }),
    );

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it('on a 202 (cleanup pending): asks to close exactly once, without confirming', async () => {
    const api = fakeProjectApi(PROJECT, READY);
    api.state.cleanupPending = true;
    const { onOpenChange, onDisconnected } = renderDialog();

    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Disconnect repository',
      }),
    );

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onDisconnected).not.toHaveBeenCalled();
  });
});
