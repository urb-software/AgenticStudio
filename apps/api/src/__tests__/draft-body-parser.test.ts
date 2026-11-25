import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { isDraftSave } from '../app.js';
import { SessionCookie } from '../platform/auth/session-cookie.js';
import { testConfig } from './test-config.js';

const config = testConfig();
const cookie = new SessionCookie(config);

function request(extra: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    method: extra.method ?? 'PUT',
    url: extra.url ?? '/api/agents/definitions-repository/draft/files',
    headers: {
      'content-type': 'application/json',
      origin: config.studioOrigin,
      cookie: `${cookie.name}=abc`,
      ...extra.headers,
    },
  } as unknown as IncomingMessage;
}

describe('the large body parser of a Draft save', () => {
  it('takes a JSON PUT from the Studio origin with a session cookie', () => {
    expect(isDraftSave(request({}), config, cookie)).toBe(true);
    expect(
      isDraftSave(
        request({ url: '/api/agents/definitions-repository/draft/files?x=1' }),
        config,
        cookie,
      ),
    ).toBe(true);
  });

  it('takes a same-origin request that sends no Origin header', () => {
    const headers = { origin: undefined as unknown as string, 'sec-fetch-site': 'same-origin' };

    expect(isDraftSave(request({ headers }), config, cookie)).toBe(true);
  });

  it.each([
    ['no session cookie', { cookie: 'other=1' }],
    ['another origin', { origin: 'https://evil.example' }],
    [
      'a cross-site request without Origin',
      { origin: undefined as unknown as string, 'sec-fetch-site': 'cross-site' },
    ],
    ['a body that is not JSON', { 'content-type': 'text/plain' }],
  ])('leaves %s to the small default parser', (_name, headers) => {
    expect(isDraftSave(request({ headers }), config, cookie)).toBe(false);
  });

  it('is for the save route and the PUT method only', () => {
    expect(isDraftSave(request({ method: 'POST' }), config, cookie)).toBe(false);
    expect(
      isDraftSave(
        request({ url: '/api/agents/definitions-repository/draft/files/move' }),
        config,
        cookie,
      ),
    ).toBe(false);
    expect(isDraftSave(request({ url: '/api/projects/x/environment-file' }), config, cookie)).toBe(
      false,
    );
  });
});
