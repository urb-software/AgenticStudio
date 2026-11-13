import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Activity, Folder } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { NavItem } from '../nav-item';

describe('NavItem', () => {
  it('links to its page and marks the active one as the current page', async () => {
    const { container } = render(
      <nav aria-label="Studio">
        <NavItem href="/projects" icon={Folder} label="Projects" active />
        <NavItem href="/executions" icon={Activity} label="Executions" badge={2} />
      </nav>,
    );

    const projects = screen.getByRole('link', { name: 'Projects' });
    expect(projects.getAttribute('href')).toBe('/projects');
    expect(projects.getAttribute('aria-current')).toBe('page');
    const executions = screen.getByRole('link', { name: 'Executions 2' });
    expect(executions.getAttribute('aria-current')).toBeNull();
    expect(projects.className).toContain('pointer-coarse:min-h-11');
    await expect(container).toHaveNoAxeViolations();
  });

  it('is a button without an href', async () => {
    const onClick = vi.fn();
    render(<NavItem icon={Folder} label="Projects" onClick={onClick} />);

    await userEvent.click(screen.getByRole('button', { name: 'Projects' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('shows only the icon when collapsed, named by its label and with a tooltip on focus', async () => {
    const { container } = render(
      <nav aria-label="Studio">
        <NavItem href="/executions" icon={Activity} label="Executions" badge={2} collapsed />
      </nav>,
    );

    const link = screen.getByRole('link', { name: 'Executions' });
    expect(link.textContent).toBe('');

    await userEvent.tab();
    expect(document.activeElement).toBe(link);
    expect((await screen.findByRole('tooltip')).textContent).toBe('Executions');
    await expect(container).toHaveNoAxeViolations();
  });
});
