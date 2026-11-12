import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig } from '../config.js';

const validEnv = {
  DATABASE_URL: 'postgresql://user:placeholder@localhost:5432/studio',
  API_PORT: '4001',
  API_ORIGIN: 'http://localhost:4001',
};

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the function to throw');
}

describe('loadConfig', () => {
  it('returns typed configuration from a valid environment', () => {
    expect(loadConfig(validEnv)).toEqual({
      apiPort: 4001,
      apiOrigin: 'http://localhost:4001',
      databaseUrl: 'postgresql://user:placeholder@localhost:5432/studio',
    });
  });

  it('defaults the API port and origin for local development', () => {
    expect(loadConfig({ DATABASE_URL: validEnv.DATABASE_URL })).toMatchObject({
      apiPort: 3001,
      apiOrigin: 'http://localhost:3001',
    });
  });

  it('ignores the generic PORT variable that next dev also reads', () => {
    expect(loadConfig({ DATABASE_URL: validEnv.DATABASE_URL, PORT: '3000' }).apiPort).toBe(3001);
  });

  it('fails fast when DATABASE_URL is missing', () => {
    const error = captureError(() => loadConfig({}));
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error.message).toMatch(/DATABASE_URL/);
  });

  it.each([
    ['DATABASE_URL', 'not a url'],
    ['DATABASE_URL', 'mysql://user@localhost/studio'],
    ['API_PORT', 'abc'],
    ['API_PORT', '0'],
    ['API_PORT', '70000'],
    ['API_ORIGIN', 'localhost:3001'],
    ['API_ORIGIN', 'ftp://localhost:3001'],
  ])('fails fast when %s is invalid (%s)', (name, value) => {
    const error = captureError(() => loadConfig({ ...validEnv, [name]: value }));
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error.message).toMatch(new RegExp(name));
  });

  it('does not echo variable values in the error message', () => {
    const leakyUrl = 'postgres-ish://user:do-not-leak@localhost/studio';
    const error = captureError(() => loadConfig({ ...validEnv, DATABASE_URL: leakyUrl }));
    expect(error.message).toMatch(/DATABASE_URL/);
    expect(error.message).not.toContain('do-not-leak');
  });
});
