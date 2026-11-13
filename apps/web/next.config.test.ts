// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveApiProxy } from './next.config';

// The /api proxy of next.config.ts (Issue #30 decision 3): a production build proxies only on
// an explicit, validated opt-in (STUDIO_WEB_API_PROXY=true + API_ORIGIN); API_ORIGIN alone
// no longer does.

describe('resolveApiProxy: next dev', () => {
  it('always proxies, to http://localhost:3001 by default', () => {
    expect(resolveApiProxy({}, { devServer: true })).toEqual({
      origin: 'http://localhost:3001',
    });
  });

  it('proxies to API_ORIGIN when it is set', () => {
    expect(resolveApiProxy({ API_ORIGIN: 'http://127.0.0.1:4001' }, { devServer: true })).toEqual({
      origin: 'http://127.0.0.1:4001',
    });
  });
});

describe('resolveApiProxy: production build and start', () => {
  it('does not proxy without the flag', () => {
    expect(resolveApiProxy({}, { devServer: false })).toEqual({ origin: undefined });
  });

  it.each(['false', ''])('does not proxy when the flag is %j', (flag) => {
    expect(resolveApiProxy({ STUDIO_WEB_API_PROXY: flag }, { devServer: false })).toEqual({
      origin: undefined,
    });
  });

  it('does not proxy on API_ORIGIN alone, and warns that it is ignored', () => {
    const result = resolveApiProxy({ API_ORIGIN: 'http://api:3001' }, { devServer: false });

    expect(result.origin).toBeUndefined();
    expect(result.warning).toMatch(/STUDIO_WEB_API_PROXY/);
  });

  it('proxies to API_ORIGIN when the flag is true', () => {
    expect(
      resolveApiProxy(
        { STUDIO_WEB_API_PROXY: 'true', API_ORIGIN: 'https://api.internal:3001' },
        { devServer: false },
      ),
    ).toEqual({ origin: 'https://api.internal:3001' });
  });

  it('fails when the flag is true but API_ORIGIN is missing', () => {
    expect(() => resolveApiProxy({ STUDIO_WEB_API_PROXY: 'true' }, { devServer: false })).toThrow(
      /STUDIO_WEB_API_PROXY=true requires API_ORIGIN/,
    );
  });
});

describe('resolveApiProxy: validation', () => {
  it.each(['TRUE', '1', 'yes', 'on'])('rejects the flag value %j', (flag) => {
    expect(() => resolveApiProxy({ STUDIO_WEB_API_PROXY: flag }, { devServer: false })).toThrow(
      /STUDIO_WEB_API_PROXY must be "true" or "false"/,
    );
  });

  it.each(['localhost:3001', 'ftp://localhost:3001', 'not a url', 'http://api:3001/path'])(
    'rejects API_ORIGIN %j',
    (origin) => {
      expect(() =>
        resolveApiProxy({ STUDIO_WEB_API_PROXY: 'true', API_ORIGIN: origin }, { devServer: false }),
      ).toThrow(/API_ORIGIN must be an http\(s\) origin/);
      expect(() => resolveApiProxy({ API_ORIGIN: origin }, { devServer: true })).toThrow(
        /API_ORIGIN must be an http\(s\) origin/,
      );
    },
  );

  it('never puts the rejected value in the error message', () => {
    expect(() =>
      resolveApiProxy({ STUDIO_WEB_API_PROXY: 'secret-ish' }, { devServer: false }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining('secret-ish') }));
  });
});
