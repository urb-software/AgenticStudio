import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { LogoutButton } from '../logout-button';

// #24 UI seam: the logout button with the generated client and the API wrapper real,
// the API faked at `fetch` and browser navigation faked at `window.location`.

let assign: Mock<(url: string) => void>;
let replace: Mock<(url: string) => void>;

beforeEach(() => {
  assign = vi.fn();
  replace = vi.fn();
  vi.stubGlobal('location', { ...window.location, pathname: '/', assign, replace });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeLogout(respond: () => Promise<Response>) {
  const fetch = vi.fn(async (request: Request): Promise<Response> => {
    expect(new URL(request.url).pathname).toBe('/api/auth/logout');
    return respond();
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function problem(status: number, detail: string): Response {
  return new Response(
    JSON.stringify({ type: 'about:blank', title: 'Error', status, detail, correlationId: 'x' }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

/** Every navigation the button triggered, by either `assign` or `replace`. */
const navigations = () => [...assign.mock.calls, ...replace.mock.calls];

const signOut = () => fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

describe('LogoutButton', () => {
  it('offers an enabled sign-out button', () => {
    render(<LogoutButton />);

    const button = screen.getByRole('button', { name: 'Sign out' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('goes to the login page after a successful logout', async () => {
    const fetch = fakeLogout(async () => new Response(null, { status: 204 }));
    render(<LogoutButton />);

    signOut();

    await waitFor(() => expect(navigations()).toEqual([['/login']]));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('goes to the login page when the session had already expired (401)', async () => {
    fakeLogout(async () => problem(401, 'Not authenticated.'));
    render(<LogoutButton />);

    signOut();

    await waitFor(() => expect(navigations()).toEqual([['/login']]));
  });

  it.each([
    ['a 403 (rejected Origin)', () => Promise.resolve(problem(403, 'Forbidden origin.'))],
    ['a 500', () => Promise.resolve(problem(500, 'Internal Server Error'))],
    ['a 503 without a body', () => Promise.resolve(new Response(null, { status: 503 }))],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('shows an error and stays on the page after %s', async (_case, respond) => {
    fakeLogout(respond);
    render(<LogoutButton />);

    signOut();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not sign out/i);
    expect(navigations()).toEqual([]);
    // The operator can try again.
    const button = screen.getByRole('button', { name: 'Sign out' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('clears the error when a retry succeeds', async () => {
    const responses = [problem(500, 'Internal Server Error'), new Response(null, { status: 204 })];
    fakeLogout(async () => responses.shift()!);
    render(<LogoutButton />);

    signOut();
    await screen.findByRole('alert');
    signOut();

    await waitFor(() => expect(navigations()).toEqual([['/login']]));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
