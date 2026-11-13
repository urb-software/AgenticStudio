import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import RootLayout, { viewport } from '../layout';

// next/font is a build-time transform; outside Next.js it only has to provide the CSS variables.
vi.mock('next/font/google', () => ({
  Inter: () => ({ variable: 'font-inter-variable' }),
  JetBrains_Mono: () => ({ variable: 'font-jetbrains-mono-variable' }),
}));

function serverHtml(): string {
  return renderToStaticMarkup(
    <RootLayout params={Promise.resolve({})}>
      <main>page</main>
    </RootLayout>,
  );
}

describe('RootLayout', () => {
  it('server-renders <html> in the dark theme, so the first paint is dark', () => {
    expect(serverHtml()).toMatch(/<html lang="en" class="[^"]*\bdark\b[^"]*"/);
  });

  it('server-renders the next-themes script that applies a stored theme before the first paint', () => {
    const html = serverHtml();
    const script = /<body[^>]*><script[^>]*>([^<]*)<\/script>/.exec(html)?.[1] ?? '';

    expect(script).toContain('localStorage.getItem');
    expect(script).toContain('"dark"');
  });

  it('exposes Inter and JetBrains Mono as CSS variables on <html>', () => {
    const html = serverHtml();

    expect(html).toMatch(/<html[^>]*class="[^"]*\bfont-inter-variable\b/);
    expect(html).toMatch(/<html[^>]*class="[^"]*\bfont-jetbrains-mono-variable\b/);
  });

  it('renders the page inside <body>', () => {
    expect(serverHtml()).toMatch(/<body[^>]*>[\s\S]*<main>page<\/main>[\s\S]*<\/body>/);
  });

  it('mounts the toast region once, for every page (#44)', () => {
    expect(serverHtml().match(/aria-label="Notifications/g)).toHaveLength(1);
  });

  it('sets the phone viewport', () => {
    expect(viewport).toMatchObject({ width: 'device-width', initialScale: 1 });
  });
});
