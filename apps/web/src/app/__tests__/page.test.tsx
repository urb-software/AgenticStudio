import { describe, expect, it, vi } from 'vitest';

// The real redirect() throws Next.js's internal NEXT_REDIRECT error; the seam is the call.
const redirect = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ redirect }));

const { default: RootPage } = await import('../page');

describe('/', () => {
  it('redirects to the Projects page on the server', () => {
    RootPage();

    expect(redirect).toHaveBeenCalledWith('/projects');
  });
});
