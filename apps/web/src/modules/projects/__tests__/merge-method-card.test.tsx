import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster, toast } from '@/shared/ui/sonner';
import { ProjectDetail } from '..';
import type { ProjectOutput } from '../../../platform/api';
import { fakeProjectApi, fieldProblem } from './fake-project-api';

// The project's Merge method card, on the project screen, with the generated client, the API
// wrapper and TanStack Query real and the API faked at `fetch`.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const PROJECT: ProjectOutput = {
  id: '00000000-0000-4000-8000-0000000000e2',
  name: 'Acme Shop',
  mergeMethod: 'squash',
  kind: 'code',
  createdAt: '2026-11-12T09:00:00.000Z',
};

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectDetail projectId={PROJECT.id} />
      <Toaster />
    </QueryClientProvider>,
  );
}

const card = () => screen.findByRole('region', { name: 'Merge method' });

afterEach(() => {
  toast.dismiss();
  vi.unstubAllGlobals();
});

describe('Merge method card', () => {
  it('offers Squash, marked as the default and chosen, and Merge commit, with nothing to save yet', async () => {
    fakeProjectApi(PROJECT);
    renderDetail();

    const region = await card();

    expect(within(region).getByRole('radio', { name: /Squash/ })).toHaveProperty('checked', true);
    expect(within(region).getByText('(default)')).toBeTruthy();
    expect(within(region).getByRole('radio', { name: 'Merge commit' })).toHaveProperty(
      'checked',
      false,
    );
    expect(within(region).getByRole('button', { name: 'Save merge method' })).toHaveProperty(
      'disabled',
      true,
    );
    await expect(document.body).toHaveNoAxeViolations();
  });

  it("shows the Project's own method", async () => {
    fakeProjectApi({ ...PROJECT, mergeMethod: 'merge_commit' });
    renderDetail();

    const region = await card();

    expect(within(region).getByRole('radio', { name: 'Merge commit' })).toHaveProperty(
      'checked',
      true,
    );
  });

  it('saves the other method and confirms it', async () => {
    const api = fakeProjectApi(PROJECT);
    renderDetail();
    const region = await card();

    await userEvent.click(within(region).getByRole('radio', { name: 'Merge commit' }));
    await userEvent.click(within(region).getByRole('button', { name: 'Save merge method' }));

    expect(await screen.findByText('Merge method saved')).toBeTruthy();
    expect(api.calls('setMergeMethod')).toEqual([
      expect.objectContaining({ body: { mergeMethod: 'merge_commit' } }),
    ]);
    await waitFor(() =>
      expect(within(region).getByRole('button', { name: 'Save merge method' })).toHaveProperty(
        'disabled',
        true,
      ),
    );
    expect(within(region).getByRole('radio', { name: 'Merge commit' })).toHaveProperty(
      'checked',
      true,
    );
  });

  it('shows the error of the API and keeps the choice', async () => {
    const api = fakeProjectApi(PROJECT);
    api.respondNext(
      'setMergeMethod',
      404,
      fieldProblem(404, 'Project not found', undefined, 'No project has this id.'),
    );
    renderDetail();
    const region = await card();

    await userEvent.click(within(region).getByRole('radio', { name: 'Merge commit' }));
    await userEvent.click(within(region).getByRole('button', { name: 'Save merge method' }));

    expect(await within(region).findByText('No project has this id.')).toBeTruthy();
    expect(within(region).getByRole('radio', { name: 'Merge commit' })).toHaveProperty(
      'checked',
      true,
    );
    expect(screen.queryByText('Merge method saved')).toBeNull();
  });
});
