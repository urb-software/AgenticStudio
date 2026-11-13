import { cleanup } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, expect } from 'vitest';

// Vitest globals are off, so React Testing Library cannot register its own cleanup.
afterEach(() => {
  cleanup();
});

// jsdom has no Fetch API, so Node's Request is used, and it rejects the relative URLs
// (`/api/...`) the generated client sends. Resolve them against the page URL, as a
// browser does, so tests can fake the API at `fetch`.
const NodeRequest = globalThis.Request;
globalThis.Request = class BrowserLikeRequest extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === 'string' ? new URL(input, window.location.href) : input, init);
  }
};

// jsdom has no layout: matchMedia answers width queries from window.innerWidth (tests set it
// to emulate a phone), and ResizeObserver, used by Radix positioning, never fires. Node-
// environment tests (next.config.test.ts) have no window.
if (typeof window !== 'undefined') {
  window.matchMedia = (query: string): MediaQueryList => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches =
      (!max || window.innerWidth <= Number(max[1])) &&
      (!min || window.innerWidth >= Number(min[1]));
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
  };
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Accessibility assertion for component tests (frontend.md §8): `await
// expect(element).toHaveNoAxeViolations()`. jsdom cannot compute colours or layout, so
// colour-contrast is left to the design-system tokens and review; `region` is a page-level
// rule (all content inside landmarks) that does not apply to a component rendered alone.
expect.extend({
  async toHaveNoAxeViolations(received: Element) {
    const { violations } = await axe.run(received, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    const summary = violations.map(
      (v) => `${v.id}: ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`,
    );
    return {
      pass: violations.length === 0,
      message: () =>
        violations.length === 0
          ? 'expected axe violations, found none'
          : `expected no axe violations, found:\n${summary.join('\n')}`,
    };
  },
});

declare module 'vitest' {
  // Type parameters must match vitest's own declaration for the interfaces to merge.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toHaveNoAxeViolations(): Promise<void>;
  }
}
