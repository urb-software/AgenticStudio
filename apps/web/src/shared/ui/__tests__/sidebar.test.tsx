import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from '../sidebar';
import { parseSidebarOpen, SIDEBAR_COOKIE_NAME } from '../sidebar-state';

function Toggle() {
  const { toggleSidebar } = useSidebar();
  return (
    <button type="button" onClick={toggleSidebar}>
      Toggle navigation
    </button>
  );
}

function Shell({ defaultOpen }: { defaultOpen?: boolean }) {
  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <Sidebar>
        <SidebarContent>
          <nav aria-label="Studio">
            <SidebarMenu>
              <SidebarMenuItem>
                <a href="/projects">Projects</a>
              </SidebarMenuItem>
            </SidebarMenu>
          </nav>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <Toggle />
      </SidebarInset>
    </SidebarProvider>
  );
}

const DESKTOP = window.innerWidth;
function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

const sidebar = (container: HTMLElement) => container.querySelector('[data-slot="sidebar"]');

describe('Sidebar', () => {
  afterEach(() => {
    setWidth(DESKTOP);
    vi.restoreAllMocks();
  });

  it('collapses to the icon rail on desktop and stores the choice in a SameSite=Lax cookie', async () => {
    setWidth(1440);
    const cookieWrites = vi.spyOn(Document.prototype, 'cookie', 'set');
    const { container } = render(<Shell />);

    expect(sidebar(container)?.getAttribute('data-state')).toBe('expanded');
    await expect(container).toHaveNoAxeViolations();

    await userEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }));

    expect(sidebar(container)?.getAttribute('data-state')).toBe('collapsed');
    expect(sidebar(container)?.getAttribute('data-collapsible')).toBe('icon');
    expect(cookieWrites).toHaveBeenCalledTimes(1);
    const parts = cookieWrites.mock.calls[0]![0].split(';').map((part) => part.trim());
    expect(parts[0]).toBe(`${SIDEBAR_COOKIE_NAME}=false`);
    expect(parts).toEqual(expect.arrayContaining(['path=/', 'SameSite=Lax']));
    expect(parts.some((part) => /^max-age=\d+$/.test(part))).toBe(true);
    // Only the flag: no other name=value pair rides along.
    expect(parts.filter((part) => part.includes('=')).map((part) => part.split('=')[0])).toEqual([
      SIDEBAR_COOKIE_NAME,
      'path',
      'max-age',
      'SameSite',
    ]);
  });

  it('server-renders the stored state, so a collapsed sidebar does not flash open', () => {
    const html = renderToString(<Shell defaultOpen={false} />);

    expect(html).toMatch(/<div[^>]*data-state="collapsed"[^>]*data-slot="sidebar"/);
  });

  it('server-renders the width-based default as CSS when no choice is stored, so tablets do not flash', () => {
    // The server cannot know the width: the markup carries data-auto, and the CSS collapses the
    // rail at tablet width (md:max-xl) until the client knows the width.
    const unset = renderToString(<Shell />);
    const stored = renderToString(<Shell defaultOpen />);

    expect(unset).toMatch(/<div[^>]*data-auto="true"[^>]*data-slot="sidebar"/);
    expect(unset).toContain('group-data-[auto=true]:md:max-xl:w-(--sidebar-width-icon)');
    expect(stored).not.toContain('data-auto');
  });

  it('drops the CSS default once the client knows the width', () => {
    setWidth(1024);
    const { container } = render(<Shell />);

    expect(sidebar(container)?.hasAttribute('data-auto')).toBe(false);
  });

  it('starts collapsed at tablet width when no choice is stored', () => {
    setWidth(1024);
    const { container } = render(<Shell />);

    expect(sidebar(container)?.getAttribute('data-state')).toBe('collapsed');
  });

  it('keeps a stored choice at tablet width, and does not store the tablet default', () => {
    setWidth(1024);
    const cookieWrites = vi.spyOn(Document.prototype, 'cookie', 'set');
    const { container: stored } = render(<Shell defaultOpen />);
    const { container: unset } = render(<Shell />);

    expect(sidebar(stored)?.getAttribute('data-state')).toBe('expanded');
    expect(sidebar(unset)?.getAttribute('data-state')).toBe('collapsed');
    expect(cookieWrites).not.toHaveBeenCalled();
  });

  it('starts expanded at desktop width when no choice is stored', () => {
    setWidth(1280);
    const { container } = render(<Shell />);

    expect(sidebar(container)?.getAttribute('data-state')).toBe('expanded');
  });

  it('is an off-canvas sheet on phones, opened by tap and closed with Esc', async () => {
    setWidth(360);
    render(<Shell />);

    expect(screen.queryByRole('link', { name: 'Projects' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }));

    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Projects' })).toBeTruthy();
    await expect(document.body).toHaveNoAxeViolations();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('has no keyboard shortcut of its own', async () => {
    setWidth(1440);
    const { container } = render(<Shell />);

    await userEvent.keyboard('{Control>}b{/Control}');

    expect(sidebar(container)?.getAttribute('data-state')).toBe('expanded');
  });
});

describe('parseSidebarOpen', () => {
  it.each([
    ['true', true],
    ['false', false],
    [undefined, undefined],
    ['', undefined],
    ['yes', undefined],
  ])('reads %j as %j', (value, expected) => {
    expect(parseSidebarOpen(value)).toBe(expected);
  });
});
