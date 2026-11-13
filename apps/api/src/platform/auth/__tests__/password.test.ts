import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_PASSWORD_HASH } from '../../../__tests__/test-config.js';
import { loadConfig } from '../../config/config.js';
import { hashPassword, verifyPassword } from '../password.js';

// Throwaway test fixture, never a real credential.
const PASSWORD = 'test-only operator password 7f3c';

describe('password hashing', () => {
  it('produces an Argon2id PHC string at the OWASP baseline that the config accepts', async () => {
    const hash = await hashPassword(PASSWORD);

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(
      loadConfig({
        DATABASE_URL: 'postgresql://u:placeholder@localhost/db',
        REDIS_URL: 'redis://localhost:6379',
        STUDIO_OPERATOR_PASSWORD_HASH: hash,
        // A throwaway key: the config requires one (Issue #57).
        STUDIO_SECRETS_KEY: randomBytes(32).toString('base64'),
        STUDIO_DATA_DIR: tmpdir(),
      }).operatorPasswordHash,
    ).toBe(hash);
  });

  it('salts every hash', async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword(PASSWORD);

    expect(await verifyPassword(hash, PASSWORD)).toBe(true);
    expect(await verifyPassword(hash, `${PASSWORD}x`)).toBe(false);
    expect(await verifyPassword(PLACEHOLDER_PASSWORD_HASH, PASSWORD)).toBe(false);
  });

  it('treats a malformed hash as a mismatch instead of throwing', async () => {
    expect(await verifyPassword('not-a-phc-string', PASSWORD)).toBe(false);
  });
});
