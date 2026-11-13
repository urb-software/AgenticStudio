import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../../platform/theme/theme-provider';

// #43 seam: the Studio Shell as `(studio)/layout.tsx` composes it, with the shell components,
// platform/auth and TanStack Query real; the request cookie, the route and the API (`fetch`)
// are faked.

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'sidebar_state' && cookie.value !== undefined
        ? { name, value: cookie.value }
        : undefined,
  }),
}));
const route = vi.hoisted(() => ({ pathname: '/projects' }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }));

const { default: StudioLayout } = await import('../layout');

async function shell(page: ReactNode = <h1>Projects</h1>) {
  return (
    <ThemeProvider>
      {await StudioLayout({ children: page, params: Promise.resolve({}) })}
    </ThemeProvider>
  );
}

const DESKTOP = window.innerWidth;
function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ authenticated: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
});

afterEach(() => {
  route.pathname = '/projects';
  cookie.value = undefined;
  setWidth(DESKTOP);
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.className = '';
});

describe('Studio Shell', () => {
  it('frames the page with labelled landmarks and a skip link to the main content', async () => {
    setWidth(1440);
    render(await shell());

    const banner = screen.getByRole('banner', { name: 'Top bar' });
    const main = screen.getByRole('main', { name: 'Page content' });
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
    expect(within(banner).getByRole('navigation', { name: 'Breadcrumb' })).toBeTruthy();
    expect(within(main).getByRole('heading', { level: 1, name: 'Projects' })).toBeTruthy();

    await userEvent.tab();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(document.activeElement).toBe(skip);
    expect(skip.getAttribute('href')).toBe(`#${main.id}`);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('shows the logo and only the Projects route, marked as the current page', async () => {
    setWidth(1440);
    render(await shell());

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Projects', '/projects'],
    ]);
    expect(links[0]!.getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('Agent Studio')).toBeTruthy();
  });

  it('shows the route as the breadcrumb', async () => {
    render(await shell());

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByText('Projects').getAttribute('aria-current')).toBe('page');
  });

  it('shows Projects › project name on a project screen (#60)', async () => {
    const id = '00000000-0000-4000-8000-0000000000a1';
    route.pathname = `/projects/${id}`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        const body = new URL(request.url).pathname.startsWith('/api/projects/')
          ? { id, name: 'Acme Shop', createdAt: '2026-11-12T09:00:00.000Z', repository: null }
          : { authenticated: true };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const { container } = render(await shell(<h1>Acme Shop</h1>));

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const projects = within(breadcrumb).getByRole('link', { name: 'Projects' });
    expect(projects.getAttribute('href')).toBe('/projects');
    expect(projects.getAttribute('aria-current')).toBeNull();
    const current = await within(breadcrumb).findByText('Acme Shop');
    expect(current.closest('[aria-current]')?.getAttribute('aria-current')).toBe('page');
    await expect(container).toHaveNoAxeViolations();
  });

  it('collapses the sidebar to the icon rail and back', async () => {
    setWidth(1440);
    render(await shell());

    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    // On the rail the label moves into the accessible name (and a tooltip).
    expect(within(nav).getByRole('link', { name: 'Projects' }).textContent).toBe('');
    expect(screen.queryByText('Agent Studio')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(within(nav).getByRole('link', { name: 'Projects' }).textContent).toBe('Projects');
  });

  it('server-renders the collapsed state stored in the cookie', async () => {
    cookie.value = 'false';

    const html = renderToString(await shell());

    expect(html).toMatch(/<div[^>]*data-state="collapsed"[^>]*data-slot="sidebar"/);
    expect(html).toContain('aria-label="Expand sidebar"');
  });

  it('server-renders the tablet rail without a cookie and keeps every control named', async () => {
    const container = document.createElement('div');
    container.innerHTML = renderToString(await shell());
    document.body.append(container);

    try {
      // The rail is CSS only (md:max-xl): the link keeps its label as its accessible name, and
      // the toggle names neither direction until the client knows the width.
      const nav = within(container).getByRole('navigation', { name: 'Primary' });
      const link = within(nav).getByRole('link', { name: 'Projects' });
      expect(link.querySelector('[class~="md:max-xl:sr-only"]')?.textContent).toBe('Projects');
      expect(within(nav).getByRole('button', { name: 'Toggle sidebar' })).toBeTruthy();
      expect(container.innerHTML).not.toContain('[&amp;&gt;span]');
    } finally {
      container.remove();
    }
  });

  it('switches between the dark and light themes from the top bar', async () => {
    setWidth(1440);
    render(await shell());

    await userEvent.click(await screen.findByRole('button', { name: 'Switch to light theme' }));

    expect(document.documentElement.classList.contains('light')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('opens the operator menu with the operator and the logout action', async () => {
    setWidth(1440);
    render(await shell());

    await userEvent.click(screen.getByRole('button', { name: 'Operator menu' }));

    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Operator')).toBeTruthy();
    expect(await within(menu).findByText('Signed in')).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Log out' })).toBeTruthy();
  });

  describe('on a phone', () => {
    it('opens the navigation as a sheet from the top bar and closes it with Esc', async () => {
      setWidth(390);
      render(await shell());

      expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();

      await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

      const sheet = screen.getByRole('dialog', { name: 'Navigation' });
      expect(within(sheet).getByRole('link', { name: 'Projects' })).toBeTruthy();
      expect(within(sheet).queryByRole('button', { name: /sidebar/i })).toBeNull();
      // Focus moves into the sheet.
      expect(sheet.contains(document.activeElement)).toBe(true);
      await expect(document.body).toHaveNoAxeViolations();

      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('closes the sheet when a route is chosen', async () => {
      setWidth(390);
      render(await shell());

      await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
      await userEvent.click(screen.getByRole('link', { name: 'Projects' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('offers the theme toggle in the operator menu', async () => {
      setWidth(390);
      render(await shell());

      await userEvent.click(screen.getByRole('button', { name: 'Operator menu' }));
      await userEvent.click(
        await within(screen.getByRole('menu')).findByRole('menuitem', {
          name: 'Switch to light theme',
        }),
      );

      expect(document.documentElement.classList.contains('light')).toBe(true);
    });
  });
});
