import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { ThemeProvider } from '../platform/theme/theme-provider';
import { Toaster } from '../shared/ui/sonner';
import './globals.css';

// Downloaded at build time and self-hosted by Next.js: the browser never calls Google.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'AI Agent Studio',
  description: 'Private, self-hosted workspace for coding agents.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

/**
 * Dark is server-rendered (`class="dark"`), so the first paint is dark even before
 * next-themes applies a stored theme; `suppressHydrationWarning` covers that class change.
 * `body` takes the bg/text tokens and the sans font from globals.css. The one Toaster (#44)
 * sits inside the theme provider so toasts follow the theme on every page.
 */
export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} dark`}
      suppressHydrationWarning
    >
      <body>
        <ThemeProvider>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
