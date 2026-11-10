import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AI Agent Studio',
  description: 'Private, self-hosted workspace for coding agents.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
