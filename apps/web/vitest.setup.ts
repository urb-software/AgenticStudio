import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

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
