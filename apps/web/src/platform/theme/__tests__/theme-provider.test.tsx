import { act, render, screen } from '@testing-library/react';
import { useTheme } from 'next-themes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme-provider';

function ThemeSwitch() {
  const { setTheme } = useTheme();
  return (
    <button type="button" onClick={() => setTheme('light')}>
      Light
    </button>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    // jsdom has no matchMedia; next-themes reads it for the system preference.
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.className = '';
  });

  it('applies the dark theme as a class on <html> by default', () => {
    render(<ThemeProvider>content</ThemeProvider>);

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(screen.getByText('content')).toBeTruthy();
  });

  it('switches <html> to the light theme', () => {
    render(
      <ThemeProvider>
        <ThemeSwitch />
      </ThemeProvider>,
    );

    act(() => screen.getByRole('button', { name: 'Light' }).click());

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });
});
