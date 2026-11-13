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

  // #20 review follow-up m8/m9.
  it.each(['refresh_token', 'client_secret', 'id_token', 'pwd', 'passwd', 'X-Api-Key'])(
    'masks the prefixed or abbreviated %s parameter value',
    (name) => {
      const output = redactSecrets(`GET https://h/cb?x=1&${name}=v4lu3&y=2 failed`);

      expect(output).not.toContain('v4lu3');
      expect(output).toContain(`${name}=***`);
      expect(output).toContain('y=2');
    },
  );

  it('masks secrets in a URL fragment', () => {
    const output = redactSecrets('redirect to https://h/cb#access_token=v4lu3&state=ok');

    expect(output).not.toContain('v4lu3');
    expect(output).toContain('#access_token=***');
    expect(output).toContain('state=ok');
  });

  it.each([
    ['colon form', 'login failed: password: v4lu3 for operator'],
    ['colon form without space', 'password:v4lu3'],
    ['JSON form', 'body {"password":"v4lu3","remember":true}'],
    ['JSON form with spaces', 'body { "client_secret" : "v4lu3" }'],
    ['single-quoted form', "options { passwd: 'v4lu3' }"],
    ['header form', 'X-Api-Key: v4lu3'],
    ['Token scheme', 'Authorization: Token v4lu3'],
    ['cookie header', 'Cookie: studio_session=v4lu3; theme=dark'],
    ['set-cookie header', 'Set-Cookie: __Host-studio_session=v4lu3; Path=/; HttpOnly'],
    ['session cookie pair', 'got studio_session=v4lu3 from client'],
  ])('masks the %s', (_case, input) => {
    expect(redactSecrets(input)).not.toContain('v4lu3');
  });

  it('keeps non-secret neighbours of a JSON secret', () => {
    expect(redactSecrets('{"password":"v4lu3","remember":true}')).toBe(
      '{"password":"***","remember":true}',
    );
  });

  it.each([
    ['argon2id', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$ZGlnZXN0ZGlnZXN0'],
    ['argon2i', '$argon2i$v=19$m=4096,t=3,p=1$c2FsdHNhbHQ$ZGlnZXN0ZGlnZXN0'],
  ])('masks an %s password hash', (_case, hash) => {
    const output = redactSecrets(`verify failed for ${hash} at startup`);

    expect(output).not.toContain('c2FsdHNhbHQ');
    expect(output).not.toContain('ZGlnZXN0ZGlnZXN0');
  });

  it('stays fast on large adversarial input (no catastrophic backtracking)', () => {
    const inputs = [
      'token'.repeat(20_000),
      `${'a-'.repeat(50_000)}password`,
      '"'.repeat(100_000),
      'a://'.repeat(25_000),
    ];
    for (const input of inputs) {
      const started = performance.now();
      redactSecrets(input);
      // Linear matching takes milliseconds; the quadratic version took 10-20 s.
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  // #24: secrets longer than the former 512-character userinfo cap.
  describe('long secrets', () => {
    const long = (length: number) => 'S3cr'.repeat(Math.ceil(length / 4)).slice(0, length);

    it.each([513, 4_096, 200_000])('masks %i-character URL userinfo whole', (length) => {
      const output = redactSecrets(
        `connect postgres://studio:${long(length)}@db.internal:5432/studio`,
      );

      expect(output).toBe('connect postgres://***@db.internal:5432/studio');
    });

    it('masks a long userinfo that itself contains @, / and :', () => {
      const secret = `${long(600)}@/:${long(600)}`;

      expect(redactSecrets(`redis://default:${secret}@h:6379 down`)).toBe(
        'redis://***@h:6379 down',
      );
    });

    it('masks the userinfo of each URL on a line', () => {
      const output = redactSecrets(
        `primary postgres://u:${long(1_000)}@a/db replica postgres://u:${long(1_000)}@b/db`,
      );

      expect(output).toBe('primary postgres://***@a/db replica postgres://***@b/db');
    });

    it.each([
      ['query parameter', (s: string) => `GET https://h/cb?access_token=${s}&y=2`],
      ['Bearer value', (s: string) => `Authorization: Bearer ${s}`],
      ['JSON value', (s: string) => `{"client_secret":"${s}","remember":true}`],
      ['colon form', (s: string) => `password: ${s} for operator`],
    ])('masks a long token in a %s', (_case, wrap) => {
      const secret = long(10_000);

      const output = redactSecrets(wrap(secret));

      expect(output).not.toContain(secret.slice(0, 600));
      expect(output).not.toContain(secret.slice(-600));
    });

    // #33 review: the scheme boundary check let these through unmasked.
    it.each([
      ['a digit before the scheme', '1postgres://u:s3cr3tv4lu3@h/db'],
      ['a dot before the scheme', 'at .postgres://u:s3cr3tv4lu3@h/db'],
      ['a hyphen before the scheme', 'x -redis://u:s3cr3tv4lu3@h:6379'],
      ['a scheme longer than 32 characters', `${'s'.repeat(40)}://u:s3cr3tv4lu3@h`],
      ['a scheme of 10 000 characters', `${'s'.repeat(10_000)}://u:s3cr3tv4lu3@h`],
    ])('masks userinfo after %s', (_case, input) => {
      const output = redactSecrets(input);

      expect(output).not.toContain('s3cr3tv4lu3');
      expect(output).toMatch(/:\/\/\*\*\*@h/);
    });

    it('stays fast on adversarial URL-shaped input (linear time)', () => {
      const inputs = [
        `${'1.-'.repeat(70_000)}://x@h`,
        '://'.repeat(70_000),
        `a://${'x'.repeat(200_000)}`,
        `a://${'@'.repeat(200_000)}`,
        'a://x'.repeat(40_000),
        'a://@'.repeat(40_000),
        'a:// '.repeat(40_000),
        `${'a:// '.repeat(20_000)}@`,
        `${'a'.repeat(100_000)}://${'b'.repeat(100_000)}`,
      ];
      for (const input of inputs) {
        const started = performance.now();
        redactSecrets(input);
        // Linear matching takes milliseconds; a quadratic scan of these takes seconds.
        expect(performance.now() - started).toBeLessThan(1000);
      }
    });
  });

  it('leaves text without secrets unchanged', () => {
    const text = 'TypeError: cannot read x of undefined\n    at handler (dist/main.js:1:2)';
    expect(redactSecrets(text)).toBe(text);
  });
});
