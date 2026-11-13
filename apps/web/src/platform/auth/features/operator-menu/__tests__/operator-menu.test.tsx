import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { DropdownMenuItem } from '@/shared/ui/dropdown-menu';
import { OperatorMenu } from '../operator-menu';

// #43 UI seam: the operator menu with the generated client, the API wrapper and TanStack Query
// real, the API faked at `fetch` and browser navigation faked at `window.location`. The logout
// cases were carried over from the removed LogoutButton (#24).

let assign: Mock<(url: string) => void>;
let replace: Mock<(url: string) => void>;

beforeEach(() => {
  assign = vi.fn();
  replace = vi.fn();
  vi.stubGlobal('location', { ...window.location, pathname: '/projects', assign, replace });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function problem(status: number, detail: string): Response {
  return new Response(
    JSON.stringify({ type: 'about:blank', title: 'Error', status, detail, correlationId: 'x' }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

const signedIn = () =>
  Promise.resolve(
    new Response(JSON.stringify({ authenticated: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

/** Fakes GET /api/auth/session and POST /api/auth/logout. */
function fakeAuthApi({
  session = signedIn,
  logout = () => Promise.resolve(new Response(null, { status: 204 })),
}: {
  session?: () => Promise<Response>;
  logout?: () => Promise<Response>;
} = {}) {
  const fetch = vi.fn(async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === '/api/auth/session' && request.method === 'GET') return session();
    if (path === '/api/auth/logout' && request.method === 'POST') return logout();
    throw new Error(`Unexpected request ${request.method} ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function renderMenu(children?: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OperatorMenu>{children}</OperatorMenu>
    </QueryClientProvider>,
  );
}

const navigations = () => [...assign.mock.calls, ...replace.mock.calls];

async function openMenu() {
  await userEvent.click(screen.getByRole('button', { name: 'Operator menu' }));
  return screen.getByRole('menu');
}

const logOut = () => userEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));

describe('OperatorMenu', () => {
  it('shows the signed-in operator once the API confirms the session', async () => {
    fakeAuthApi();
    renderMenu();

    const menu = await openMenu();

    expect(within(menu).getByText('Operator')).toBeTruthy();
    expect(await within(menu).findByText('Signed in')).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Log out' })).toBeTruthy();
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('opens from the keyboard and closes with Esc', async () => {
    fakeAuthApi();
    renderMenu();

    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Operator menu' }));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeTruthy();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('sends the browser to the login page when there is no session (401)', async () => {
    fakeAuthApi({ session: () => Promise.resolve(problem(401, 'Not authenticated.')) });
    renderMenu();

    await waitFor(() => expect(navigations()).toEqual([['/login']]));
  });

  it('says so when the session cannot be checked', async () => {
    fakeAuthApi({ session: () => Promise.resolve(problem(503, 'Unavailable')) });
    renderMenu();

    const menu = await openMenu();

    expect(await within(menu).findByText('Could not check the session')).toBeTruthy();
    expect(navigations()).toEqual([]);
  });

  it('renders extra items passed by the shell', async () => {
    fakeAuthApi();
    renderMenu(<DropdownMenuItem>Switch to light theme</DropdownMenuItem>);

    const menu = await openMenu();

    expect(within(menu).getByRole('menuitem', { name: 'Switch to light theme' })).toBeTruthy();
  });

  it('goes to the login page after a successful logout', async () => {
    const fetch = fakeAuthApi();
    renderMenu();

    await openMenu();
    await logOut();

    await waitFor(() => expect(navigations()).toEqual([['/login']]));
    const logouts = fetch.mock.calls.filter(
      ([request]) => new URL(request.url).pathname === '/api/auth/logout',
    );
    expect(logouts).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('goes to the login page when the session had already expired (401)', async () => {
    fakeAuthApi({ logout: () => Promise.resolve(problem(401, 'Not authenticated.')) });
    renderMenu();

    await openMenu();
    await logOut();

    await waitFor(() => expect(navigations()).toEqual([['/login']]));
  });

  it.each([
    ['a 403 (rejected Origin)', () => Promise.resolve(problem(403, 'Forbidden origin.'))],
    ['a 500', () => Promise.resolve(problem(500, 'Internal Server Error'))],
    ['a 503 without a body', () => Promise.resolve(new Response(null, { status: 503 }))],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('shows an error and stays on the page after %s', async (_case, logout) => {
    fakeAuthApi({ logout });
    renderMenu();

    await openMenu();
    await logOut();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not log out/i);
    expect(navigations()).toEqual([]);
    // The operator can try again.
    const item = screen.getByRole('menuitem', { name: 'Log out' });
    expect(item.getAttribute('aria-disabled')).toBeNull();
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('clears the error when a retry succeeds', async () => {
    const responses = [problem(500, 'Internal Server Error'), new Response(null, { status: 204 })];
    fakeAuthApi({ logout: async () => responses.shift()! });
    renderMenu();

    await openMenu();
    await logOut();
    await screen.findByRole('alert');
    await logOut();

    await waitFor(() => expect(navigations()).toEqual([['/login']]));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
