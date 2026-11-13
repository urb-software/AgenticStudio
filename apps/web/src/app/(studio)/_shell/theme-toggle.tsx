'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { IconButton } from '@/shared/components/icon-button';
import { useHydrated } from '@/shared/hooks/use-hydrated';
import { DropdownMenuItem } from '@/shared/ui/dropdown-menu';

/**
 * The stored theme is known only in the browser, so the server render and hydration assume the
 * default (dark) and the control shows the real theme right after.
 */
function useThemeSwitch() {
  const { resolvedTheme, setTheme } = useTheme();
  const hydrated = useHydrated();
  const light = hydrated && resolvedTheme === 'light';
  return {
    label: light ? 'Switch to dark theme' : 'Switch to light theme',
    icon: light ? Moon : Sun,
    toggle: () => setTheme(light ? 'dark' : 'light'),
  };
}

/** Top-bar theme toggle (dark/light, persisted by next-themes); hidden on phones. */
export function ThemeToggle() {
  const { label, icon, toggle } = useThemeSwitch();
  return (
    <IconButton icon={icon} label={label} className="hidden md:inline-flex" onClick={toggle} />
  );
}

/** The theme toggle as an operator-menu item, shown on phones only (frontend.md §9). */
export function ThemeMenuItem() {
  const { label, icon: Icon, toggle } = useThemeSwitch();
  return (
    <DropdownMenuItem className="md:hidden" onSelect={toggle}>
      <Icon aria-hidden="true" />
      {label}
    </DropdownMenuItem>
  );
}
