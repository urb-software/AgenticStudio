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

  it('keeps the badge count in the accessible name when collapsed', () => {
    render(<NavItem href="/runs" icon={Activity} label="Runs" badge={3} collapsed />);

    expect(screen.getByRole('link', { name: 'Runs, 3' })).toBeTruthy();
  });

  it('is a button without an href', async () => {
    const onClick = vi.fn();
    render(<NavItem icon={Folder} label="Projects" onClick={onClick} />);

    await userEvent.click(screen.getByRole('button', { name: 'Projects' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('shows only the icon when collapsed, named by its label and with a tooltip on focus', async () => {
    render(
      <nav aria-label="Studio">
        <NavItem href="/executions" icon={Activity} label="Executions" collapsed />
      </nav>,
    );

    const link = screen.getByRole('link', { name: 'Executions' });
    expect(link.textContent).toBe('');

    await userEvent.tab();
    expect(document.activeElement).toBe(link);
    expect((await screen.findByRole('tooltip')).textContent).toBe('Executions');
    // The open tooltip is portalled to body.
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('can draw the icon rail at tablet width in CSS alone, keeping the label as its name', () => {
    render(
      <nav aria-label="Studio">
        <NavItem href="/projects" icon={Folder} label="Projects" badge={2} collapsed="tablet" />
      </nav>,
    );

    // Server render before the width is known: the label and badge stay in the accessible name,
    // only visually hidden between 768 and 1279px; no tooltip without JS.
    const link = screen.getByRole('link', { name: 'Projects 2' });
    expect(link.getAttribute('aria-label')).toBeNull();
    expect(link.className.split(' ')).toContain('md:max-xl:justify-center');
    const hidden = link.querySelectorAll('[class~="md:max-xl:sr-only"]');
    expect([...hidden].map((node) => node.textContent)).toEqual(['Projects', '2']);
  });
});
