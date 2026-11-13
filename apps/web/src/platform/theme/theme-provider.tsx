'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ReactNode } from 'react';

/**
 * Light and dark themes as a class on <html> (the `.dark` tokens of globals.css), dark by
 * default. next-themes injects a blocking script that applies the stored theme before the
 * first paint, so there is no flash; the root layout stays a Server Component (frontend.md §6).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}
