import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { LoginForm } from '../login-form';

// #44 UI seam: the login form with the generated client and the API wrapper real, the API
// faked at `fetch` and Next.js navigation faked at `useRouter`.

const replace: Mock<(href: string) => void> = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

beforeEach(() => {
  replace.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function problemResponse(
  status: number,
  title: string,
  detail: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ type: 'about:blank', title, status, detail, correlationId: 'x' }),
    { status, headers: { 'Content-Type': 'application/problem+json', ...headers } },
  );
}

const signedIn = () =>
  new Response(JSON.stringify({ authenticated: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** Fakes POST /api/auth/login with `respond`; returns the fetch mock. */
function fakeLogin(respond: () => Promise<Response> | Response) {
  const fetch = vi.fn(async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === '/api/auth/login' && request.method === 'POST') return respond();
    throw new Error(`Unexpected request ${request.method} ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const passwordInput = () => screen.getByLabelText<HTMLInputElement>('Password');

async function signIn(password = 'secret') {
  await userEvent.type(passwordInput(), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginForm', () => {
  it('signs in and goes to the Studio', async () => {
    const fetch = fakeLogin(signedIn);
    const { container } = render(<LoginForm />);
    await expect(container).toHaveNoAxeViolations();

    await signIn();

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the button disabled until a password is entered', () => {
    fakeLogin(signedIn);
    render(<LoginForm />);

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in' }).disabled).toBe(true);
  });

  it('shows a pending state and cannot be submitted twice', async () => {
    let finish: (response: Response) => void = () => {};
    const fetch = fakeLogin(() => new Promise<Response>((resolve) => (finish = resolve)));
    const { container } = render(<LoginForm />);

    await signIn();

    const pending = screen.getByRole<HTMLButtonElement>('button', { name: 'Signing in…' });
    expect(pending.disabled).toBe(true);
    expect(pending.getAttribute('aria-busy')).toBe('true');
    expect(passwordInput().disabled).toBe(true);
    // Enter in the field and another click while the request is in flight do nothing.
    await userEvent.click(pending);
    pending.form?.requestSubmit();
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(container).toHaveNoAxeViolations();

    finish(signedIn());
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shows a wrong password next to the field and clears it', async () => {
    fakeLogin(() => problemResponse(401, 'Unauthorized', 'Not authenticated.'));
    const { container } = render(<LoginForm />);

    await signIn();

    const error = await screen.findByText('Wrong password.');
    expect(passwordInput().getAttribute('aria-invalid')).toBe('true');
    expect(passwordInput().getAttribute('aria-describedby')).toContain(error.id);
    expect(passwordInput().value).toBe('');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows a rate limit in the awaiting (amber) banner with the wait in minutes', async () => {
    fakeLogin(() =>
      problemResponse(
        429,
        'Too Many Requests',
        'Too many failed login attempts. Try again later.',
        { 'Retry-After': '120' },
      ),
    );
    const { container } = render(<LoginForm />);

    await signIn();

    // Announced assertively, as the lockout message was before #44.
    const banner = await screen.findByRole('alert');
    expect(banner.dataset.tone).toBe('warning');
    expect(banner.querySelector('b')?.textContent?.trim()).toBe('Too many failed attempts.');
    expect(banner.textContent).toContain('Try again in 2 minutes.');
    expect(passwordInput().getAttribute('aria-invalid')).not.toBe('true');
    await expect(container).toHaveNoAxeViolations();
  });

  it('says "1 minute" when the rate limit has no Retry-After', async () => {
    fakeLogin(() => problemResponse(429, 'Too Many Requests', 'Try again later.'));
    render(<LoginForm />);

    await signIn();

    expect((await screen.findByRole('alert')).textContent).toContain('Try again in 1 minute.');
  });

  it('shows a server error with the problem title in bold, then the detail', async () => {
    fakeLogin(() =>
      problemResponse(503, 'Service Unavailable', 'The session store is not reachable.'),
    );
    const { container } = render(<LoginForm />);

    await signIn();

    const alert = await screen.findByRole('alert');
    expect(alert.dataset.tone).toBe('danger');
    expect(alert.querySelector('b')?.textContent?.trim()).toBe('Service Unavailable');
    expect(alert.textContent).toContain('The session store is not reachable.');
    await expect(container).toHaveNoAxeViolations();
  });

  it('keeps the generic message under the title when the problem has an empty detail', async () => {
    fakeLogin(() => problemResponse(503, 'Service Unavailable', ''));
    render(<LoginForm />);

    await signIn();

    const alert = await screen.findByRole('alert');
    expect(alert.querySelector('b')?.textContent?.trim()).toBe('Service Unavailable');
    expect(alert.textContent).toContain('Login failed. Try again.');
  });

  it('falls back to a generic message when the server error has no problem details', async () => {
    fakeLogin(() => new Response('Bad gateway', { status: 502 }));
    render(<LoginForm />);

    await signIn();

    expect((await screen.findByRole('alert')).textContent).toBe('Login failed. Try again.');
  });

  it('shows the generic message when the request fails without a response', async () => {
    // The generated client reports a failed fetch as a response-less error (status 0), so
    // today's rules show the generic message, as before #44.
    fakeLogin(() => Promise.reject(new TypeError('Failed to fetch')));
    render(<LoginForm />);

    await signIn();

    expect((await screen.findByRole('alert')).textContent).toBe('Login failed. Try again.');
  });
});
