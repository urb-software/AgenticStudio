import { createSecretKey, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const createdDataDirs: string[] = [];

/**
 * A fresh data directory per call: every app start sweeps `studio-git-*` under its data
 * directory, so apps (even two in one file) must never share one. Removed by the Vitest
 * setup file via {@link removeCreatedDataDirs}.
 */
export function createTestDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-test-'));
  createdDataDirs.push(dir);
  return dir;
}

/** The data directories this module instance has created and not yet removed. */
export function createdTestDataDirs(): readonly string[] {
  return [...createdDataDirs];
}

/** Removes the data directories this module instance created; a failure is logged and ignored. */
export async function removeCreatedDataDirs(): Promise<void> {
  const dirs = createdDataDirs.splice(0);
  await Promise.all(
    dirs.map((dir) =>
      rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
        console.warn(`Could not remove test data directory ${dir}:`, error);
      }),
    ),
  );
}

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
    // A private directory per call unless the suite passes its own.
    dataDir: overrides.dataDir ?? createTestDataDir(),
    gitAllowFileRemotes: false,
    // The production default: loopback and private remotes are refused. Suites whose fixtures
    // listen on 127.0.0.1 opt in explicitly.
    gitAllowPrivateRemotes: false,
    sshKnownHosts: [],
    // No worker token: worker routes reject unless a suite sets one.
    workerToken: null,
    workerLeaseSeconds: 60,
    runLimits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
    runLogMaxBytes: 8 * 1024 * 1024,
    runSnapshotRetentionDays: 7,
    operatorGithubLogin: null,
    // Merging off unless a suite sets a credential.
    mergeCredential: null,
    mergeGithubApiUrl: null,
    retention: {
      days: 7,
      maxPerProject: 10,
      openPullRequestIdleDays: 30,
      hoursAfterPullRequestEnd: 24,
    },
    ...overrides,
  };
}

/**
 * App options for tests that build the app without the services the job-queue workers need
 * at start-up (Redis for reconciliation, PostgreSQL for the clone queue's owner): queues
 * register, but no worker starts. Tests of background jobs use the real services instead.
 */
export const WITHOUT_QUEUE_WORKERS = { queue: { startWorkers: false } } as const;
