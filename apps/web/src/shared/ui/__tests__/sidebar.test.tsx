import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Folder } from 'lucide-react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '../sidebar';

function Shell() {
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarContent>
          <nav aria-label="Studio">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive>
                  <Folder aria-hidden="true" />
                  <span>Projects</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </nav>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <SidebarTrigger />
      </SidebarInset>
    </SidebarProvider>
  );
}

const DESKTOP = window.innerWidth;
function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

describe('Sidebar', () => {
  afterEach(() => setWidth(DESKTOP));

  it('collapses to the icon rail on desktop from its labelled trigger', async () => {
    setWidth(1440);
    const { container } = render(<Shell />);

    const sidebar = container.querySelector('[data-slot="sidebar"]');
    expect(sidebar?.getAttribute('data-state')).toBe('expanded');
    expect(screen.getByRole('button', { name: 'Projects' })).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();

    await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));

    expect(sidebar?.getAttribute('data-state')).toBe('collapsed');
    expect(sidebar?.getAttribute('data-collapsible')).toBe('icon');
  });

  it('is an off-canvas sheet on phones, opened by tap and closed with Esc', async () => {
    setWidth(360);
    render(<Shell />);

    expect(screen.queryByRole('button', { name: 'Projects' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));

    expect(screen.getByRole('dialog', { name: 'Sidebar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Projects' }).className).toContain(
      'pointer-coarse:min-h-11',
    );
    await expect(document.body).toHaveNoAxeViolations();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
