import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../redact.js';

describe('redactSecrets', () => {
  it.each([
    ['plain user:password', 'connect postgres://studio:s3cr3t@10.0.0.5:5432/db failed', 's3cr3t'],
    ['password containing @', 'postgres://u:p@ss@h/db', 'p@ss'],
    ['password containing /', 'postgres://u:pa/ss@h/db', 'pa/ss'],
    ['password containing :', 'redis://default:a:b:c@h:6379', 'a:b:c'],
    ['user only', 'https://ghp_tok3n@github.com/org/repo.git', 'ghp_tok3n'],
  ])('masks the whole URL userinfo (%s)', (_case, input, secret) => {
    const output = redactSecrets(input);

    expect(output).not.toContain(secret);
    expect(output).toMatch(/:\/\/\*\*\*@/);
  });

  it('keeps the host so the log stays useful', () => {
    expect(redactSecrets('connect postgres://u:p@ss@db.internal:5432/studio')).toBe(
      'connect postgres://***@db.internal:5432/studio',
    );
  });

  it.each([
    'token',
    'access_token',
    'password',
    'secret',
    'api_key',
    'apikey',
    'TOKEN',
    'Password',
    'API_KEY',
  ])('masks the %s query parameter value', (name) => {
    const output = redactSecrets(`GET https://h/cb?x=1&${name}=v4lu3&y=2 failed`);

    expect(output).not.toContain('v4lu3');
    expect(output).toContain(`${name}=***`);
    expect(output).toContain('x=1');
    expect(output).toContain('y=2');
  });

  it('masks key=value secrets outside a URL (e.g. connection strings)', () => {
    const output = redactSecrets('host=db password=s3cr3t user=studio');

    expect(output).not.toContain('s3cr3t');
    expect(output).toContain('password=***');
    expect(output).toContain('user=studio');
  });

  it.each([
    ['Bearer', 'Authorization: Bearer eyJhbGciOi.payload.sig'],
    ['Basic', 'Authorization: Basic dXNlcjpwYXNz'],
    ['bearer', 'header bearer abc-def_123'],
  ])('masks %s authorization values', (scheme, input) => {
    const output = redactSecrets(input);

    expect(output).toContain(`${scheme} ***`);
    expect(output).not.toMatch(/eyJhbGciOi|dXNlcjpwYXNz|abc-def_123/);
  });

  it('leaves text without secrets unchanged', () => {
    const text = 'TypeError: cannot read x of undefined\n    at handler (dist/main.js:1:2)';
    expect(redactSecrets(text)).toBe(text);
  });
});
