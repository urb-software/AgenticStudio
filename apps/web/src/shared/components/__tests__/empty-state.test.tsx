import { render, screen } from '@testing-library/react';
import { Folder, TriangleAlert } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { Button } from '@/shared/ui/button';
import { EmptyState } from '../empty-state';

describe('EmptyState', () => {
  it('says what to do, explains the thing and offers one action', async () => {
    const { container } = render(
      <EmptyState
        icon={Folder}
        title="Create your first project"
        description="A project connects a Git repository to agents and runs."
        action={<Button variant="primary">New project</Button>}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Create your first project' })).toBeTruthy();
    expect(
      screen.getByText('A project connects a Git repository to agents and runs.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New project' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('announces a failed load in the error tone with a retry', async () => {
    const { container } = render(
      <EmptyState
        tone="error"
        icon={TriangleAlert}
        title="Couldn't load projects"
        description={<code>GET /api/projects · 503</code>}
        action={<Button>Retry</Button>}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert.dataset.tone).toBe('error');
    expect(alert.textContent).toContain("Couldn't load projects");
    expect(alert.textContent).toContain('GET /api/projects · 503');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });
});
