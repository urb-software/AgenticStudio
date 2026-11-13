import { createSecretKey, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { AppConfig } from '../platform/config/config.js';

/**
 * A format-valid Argon2id PHC string with a dummy salt and digest. No password
 * verifies against it; tests that log in hash their own throwaway password.
 */
export const PLACEHOLDER_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$cGxhY2Vob2xkZXJzYWx0$cGxhY2Vob2xkZXJkaWdlc3RwbGFjZWhvbGRlcmRpZ2Vz';

/** A throwaway SecretStore master key, generated per test run; no key material is committed. */
export function throwawaySecretsKey() {
  return createSecretKey(randomBytes(32));
}

const TEST_SECRETS_KEY = throwawaySecretsKey();

/**
 * Configuration for tests that build the app. The database and Redis clients connect
 * lazily, so the unreachable defaults are never contacted unless a test uses them.
 */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiPort: 0,
    apiHost: '127.0.0.1',
    apiOrigin: 'http://localhost:3001',
    apiTrustedProxies: [],
    databaseUrl: 'postgresql://unused:unused@127.0.0.1:1/unused',
    redisUrl: 'redis://127.0.0.1:1',
    studioOrigin: 'http://localhost:3000',
    operatorPasswordHash: PLACEHOLDER_PASSWORD_HASH,
    secretsKey: TEST_SECRETS_KEY,
    // Nothing is written there unless a test clones; such tests pass their own directory.
    dataDir: tmpdir(),
    gitAllowFileRemotes: false,
    ...overrides,
  };
}
