import { deployMigrations } from '@agentic-studio/database/migrations';
import { startPostgres, type TestService } from '@agentic-studio/testing';
import {
  Controller,
  Get,
  Inject,
  type INestApplication,
  type LoggerService,
  Module,
  Param,
} from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testConfig, throwawaySecretsKey } from '../../../__tests__/test-config.js';
import { AppModule } from '../../../app.module.js';
import { buildApp, createApp } from '../../../app.js';
import { Public } from '../../auth/public.decorator.js';
import type { AppConfig } from '../../config/config.js';
import { DATABASE_CLIENT, type DatabaseClient } from '../../database/database.module.js';
import {
  SECRET_STORE,
  SecretDecryptionFailedError,
  SecretNotFoundError,
  type SecretReference,
  type SecretStore,
  SecretStoreError,
} from '../index.js';
import { SecretsModule } from '../secrets.module.js';

// Issue #57: the SecretStore port against real PostgreSQL (Testcontainers), through the app's
// DI container as a consumer would use it. Assertions go through the port; the secrets table
// is read or changed directly only to observe storage at rest or to simulate tampering.

/** A throwaway value shaped like the deploy keys the store will hold: multi-line, non-ASCII. */
const SECRET_VALUE =
  '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-only-do-not-leak-7f3a ünïcødé\n-----END OPENSSH PRIVATE KEY-----\n';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface SecretRow {
  id: string;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  auth_tag: Uint8Array;
  key_version: number;
  created_at: Date;
}

/** Captures what the app logs at every level, so tests can assert nothing leaks. */
class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  private capture = (...parts: unknown[]) => this.lines.push(parts.map(String).join(' '));
  log = this.capture;
  error = this.capture;
  warn = this.capture;
  debug = this.capture;
  verbose = this.capture;
  fatal = this.capture;
}

// Test-only endpoint: resolves a reference the way a business module would at the point of
// use, so the suite can observe what a failure turns into at the HTTP boundary and in logs.
@Public()
@Controller('__test__/secrets')
class SecretProbeController {
  constructor(@Inject(SECRET_STORE) private readonly secrets: SecretStore) {}

  @Get(':reference')
  async resolve(@Param('reference') reference: string): Promise<{ length: number }> {
    return { length: (await this.secrets.get(reference)).length };
  }
}

function probeRootModule(config: AppConfig) {
  @Module({
    imports: [AppModule.register(config), SecretsModule],
    controllers: [SecretProbeController],
  })
  class SecretProbeRootModule {}
  return SecretProbeRootModule;
}

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the promise to reject');
}

/** Every rendering of an error a log line, problem body or caller could end up printing. */
function renderings(error: Error): string[] {
  return [
    error.message,
    error.stack ?? '',
    String(error),
    JSON.stringify(error),
    JSON.stringify(Object.getOwnPropertyDescriptors(error)),
  ];
}

describe('SecretStore (PostgreSQL via Testcontainers)', () => {
  let postgres: TestService;
  let config: AppConfig;
  let app: INestApplication;
  let store: SecretStore;
  let db: DatabaseClient;
  const logger = new CapturingLogger();

  const rowOf = async (reference: SecretReference): Promise<SecretRow> => {
    const [row] = await db.$queryRaw<SecretRow[]>`
      SELECT id::text AS id, ciphertext, nonce, auth_tag, key_version, created_at
      FROM secrets WHERE id = ${reference}::uuid`;
    if (!row) throw new Error(`no secrets row for ${reference}`);
    return row;
  };

  beforeAll(async () => {
    postgres = await startPostgres();
    await deployMigrations(postgres.url);
    config = testConfig({ databaseUrl: postgres.url });
    app = await buildApp(probeRootModule(config), { logger });
    await app.init();
    store = app.get<SecretStore>(SECRET_STORE);
    db = app.get<DatabaseClient>(DATABASE_CLIENT);
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
  });

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE secrets`;
    logger.lines.length = 0;
  });

  it('is provided by the production app', async () => {
    const production = await createApp(config);
    try {
      const reference = await production.get<SecretStore>(SECRET_STORE).put(SECRET_VALUE);
      expect(await store.get(reference)).toBe(SECRET_VALUE);
    } finally {
      await production.close();
    }
  });

  it('round-trips a value through an opaque reference', async () => {
    const reference = await store.put(SECRET_VALUE);

    expect(reference).toMatch(UUID);
    expect(await store.get(reference)).toBe(SECRET_VALUE);
  });

  it('round-trips an empty value', async () => {
    expect(await store.get(await store.put(''))).toBe('');
  });

  it('stores only AES-256-GCM ciphertext, a 12-byte nonce, a 16-byte tag and key version 1', async () => {
    const reference = await store.put(SECRET_VALUE);

    const row = await rowOf(reference);
    const plaintext = Buffer.from(SECRET_VALUE, 'utf8');
    expect(row.id).toBe(reference);
    expect(row.nonce).toHaveLength(12);
    expect(row.auth_tag).toHaveLength(16);
    expect(row.key_version).toBe(1);
    expect(row.created_at).toBeInstanceOf(Date);
    // GCM is a stream mode: same length as the plaintext, but none of its bytes in the clear.
    expect(row.ciphertext).toHaveLength(plaintext.length);
    expect(Buffer.from(row.ciphertext).includes(plaintext.subarray(0, 16))).toBe(false);
    expect(Buffer.from(row.ciphertext).toString('latin1')).not.toContain('test-only-do-not-leak');
  });

  it('uses a fresh nonce for every value, even when the value repeats', async () => {
    const references = await Promise.all(Array.from({ length: 20 }, () => store.put(SECRET_VALUE)));

    const rows = await Promise.all(references.map(rowOf));
    expect(new Set(references).size).toBe(20);
    expect(new Set(rows.map((row) => Buffer.from(row.nonce).toString('hex'))).size).toBe(20);
    expect(new Set(rows.map((row) => Buffer.from(row.ciphertext).toString('hex'))).size).toBe(20);
  });

  it('fails closed when the master key is not the one that sealed the value', async () => {
    const reference = await store.put(SECRET_VALUE);
    const otherKeyApp = await createApp(
      testConfig({ ...config, secretsKey: throwawaySecretsKey() }),
    );
    try {
      const error = await captureRejection(
        otherKeyApp.get<SecretStore>(SECRET_STORE).get(reference),
      );
      expect(error).toBeInstanceOf(SecretDecryptionFailedError);
    } finally {
      await otherKeyApp.close();
    }
  });

  it.each([
    ['ciphertext', 'ciphertext'],
    ['nonce', 'nonce'],
    ['authentication tag', 'auth_tag'],
  ] as const)('fails closed when the stored %s is tampered with', async (_, column) => {
    const reference = await store.put(SECRET_VALUE);
    const tampered = Buffer.from((await rowOf(reference))[column]);
    tampered[0]! ^= 0x01;

    // The column name comes from the fixed list above, never from input.
    await db.$executeRawUnsafe(
      `UPDATE secrets SET ${column} = $1 WHERE id = $2::uuid`,
      tampered,
      reference,
    );

    expect(await captureRejection(store.get(reference))).toBeInstanceOf(
      SecretDecryptionFailedError,
    );
  });

  it('fails closed when a sealed value is copied into another row (reference bound as AAD)', async () => {
    const original = await store.put(SECRET_VALUE);
    const victim = await store.put('another throwaway value');
    const sealed = await rowOf(original);

    await db.$executeRaw`
      UPDATE secrets SET ciphertext = ${sealed.ciphertext}, nonce = ${sealed.nonce},
        auth_tag = ${sealed.auth_tag}
      WHERE id = ${victim}::uuid`;

    expect(await captureRejection(store.get(victim))).toBeInstanceOf(SecretDecryptionFailedError);
    expect(await store.get(original)).toBe(SECRET_VALUE);
  });

  it('fails closed on a row sealed with an unknown key version', async () => {
    const reference = await store.put(SECRET_VALUE);

    await db.$executeRaw`UPDATE secrets SET key_version = 2 WHERE id = ${reference}::uuid`;

    expect(await captureRejection(store.get(reference))).toBeInstanceOf(
      SecretDecryptionFailedError,
    );
  });

  it.each([
    ['an unknown reference', '9b2f6c1e-4d0a-4f7b-8e3c-2a1d5f6b7c8d'],
    ['a malformed reference', 'not-a-reference'],
    ['an empty reference', ''],
  ])('reports %s as not found', async (_, reference) => {
    expect(await captureRejection(store.get(reference))).toBeInstanceOf(SecretNotFoundError);
  });

  it('forgets a deleted value, and deleting it again is a no-op', async () => {
    const reference = await store.put(SECRET_VALUE);
    const kept = await store.put('kept throwaway value');

    await store.delete(reference);
    await store.delete(reference);
    await store.delete('not-a-reference');

    expect(await captureRejection(store.get(reference))).toBeInstanceOf(SecretNotFoundError);
    expect(await store.get(kept)).toBe('kept throwaway value');
  });

  it('throws typed errors with fixed messages that carry no value, ciphertext or key', async () => {
    const reference = await store.put(SECRET_VALUE);
    const sealed = await rowOf(reference);
    await db.$executeRaw`UPDATE secrets SET auth_tag = ${Buffer.alloc(16)} WHERE id = ${reference}::uuid`;

    const failures = [
      await captureRejection(store.get(reference)),
      await captureRejection(store.get('9b2f6c1e-4d0a-4f7b-8e3c-2a1d5f6b7c8d')),
    ];

    expect(failures[0]).toBeInstanceOf(SecretStoreError);
    expect(failures[0]!.message).toBe('The secret could not be decrypted.');
    expect(failures[1]).toBeInstanceOf(SecretStoreError);
    expect(failures[1]!.message).toBe('The secret was not found.');
    const forbidden = [
      'test-only-do-not-leak',
      Buffer.from(sealed.ciphertext).toString('base64').slice(0, 16),
      Buffer.from(sealed.ciphertext).toString('hex').slice(0, 16),
      config.secretsKey.export().toString('base64'),
      config.secretsKey.export().toString('hex'),
    ];
    for (const error of failures) {
      expect(error.cause).toBeUndefined();
      for (const rendered of renderings(error)) {
        for (const leak of forbidden) expect(rendered).not.toContain(leak);
      }
    }
  });

  it('keeps the value out of problem+json bodies and logs when resolving fails', async () => {
    const reference = await store.put(SECRET_VALUE);
    const sealed = await rowOf(reference);
    await db.$executeRaw`UPDATE secrets SET key_version = 99 WHERE id = ${reference}::uuid`;
    const tamperedReference = await store.put(SECRET_VALUE);
    await db.$executeRaw`UPDATE secrets SET ciphertext = ${Buffer.alloc(sealed.ciphertext.length)} WHERE id = ${tamperedReference}::uuid`;

    for (const path of [reference, tamperedReference, '9b2f6c1e-4d0a-4f7b-8e3c-2a1d5f6b7c8d']) {
      const response = await request(app.getHttpServer()).get(`/api/__test__/secrets/${path}`);

      expect(response.status).toBe(500);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(response.body.detail).toBe('An unexpected error occurred.');
      expect(response.text).not.toContain('test-only-do-not-leak');
    }
    expect(logger.lines.length).toBeGreaterThan(0);
    const logged = logger.lines.join('\n');
    expect(logged).not.toContain('test-only-do-not-leak');
    expect(logged).not.toContain(Buffer.from(sealed.ciphertext).toString('base64').slice(0, 16));
    expect(logged).not.toContain(config.secretsKey.export().toString('base64'));
  });
});
