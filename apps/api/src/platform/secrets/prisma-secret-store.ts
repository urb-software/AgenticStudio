import { type KeyObject, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { DATABASE_CLIENT, type DatabaseClient } from '../database/database.module.js';
import { seal, unseal } from './aes-256-gcm.js';
import {
  SecretDecryptionFailedError,
  SecretNotFoundError,
  type SecretOwner,
  type SecretReference,
  type SecretStore,
  SecretStoreUnavailableError,
} from './secret-store.js';

/** Version of `STUDIO_SECRETS_KEY`, stored with every row; the only one until rotation exists. */
export const CURRENT_KEY_VERSION = 1;

const REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An owner label (`SecretOwner`); the migration's CHECK constraint has the same pattern. */
const OWNER = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const OWNER_MAX_LENGTH = 64;
/** An error code safe to log (e.g. Prisma `P2002`, PostgreSQL `23514`): no free text. */
const LOGGABLE_CODE = /^[A-Za-z0-9_]{1,32}$/;

/**
 * The PostgreSQL adapter of the {@link SecretStore} (ADR 0001): AES-256-GCM with a fresh
 * random nonce per value, the reference bound as additional authenticated data, and the key
 * version stored per row. The only code that handles ciphertext or the master key.
 */
@Injectable()
export class PrismaSecretStore implements SecretStore {
  private readonly logger = new Logger('SecretStore');
  /** Master keys by version. A row whose version is missing here fails closed. */
  private readonly keys: ReadonlyMap<number, KeyObject>;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: DatabaseClient,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.keys = new Map([[CURRENT_KEY_VERSION, config.secretsKey]]);
  }

  async put(value: string, { owner }: { owner: SecretOwner }): Promise<SecretReference> {
    assertOwner(owner);
    const id = randomUUID();
    const sealed = seal(this.keys.get(CURRENT_KEY_VERSION)!, value, aadOf(id));
    await this.database('put', () =>
      this.db.secret.create({
        data: {
          id,
          ciphertext: new Uint8Array(sealed.ciphertext),
          nonce: new Uint8Array(sealed.nonce),
          authTag: new Uint8Array(sealed.authTag),
          keyVersion: CURRENT_KEY_VERSION,
          owner,
        },
      }),
    );
    return id;
  }

  async get(reference: SecretReference): Promise<string> {
    const row = isReference(reference)
      ? await this.database('get', () => this.db.secret.findUnique({ where: { id: reference } }))
      : null;
    if (!row) {
      throw new SecretNotFoundError();
    }
    const key = this.keys.get(row.keyVersion);
    const sealed = {
      ciphertext: Buffer.from(row.ciphertext),
      nonce: Buffer.from(row.nonce),
      authTag: Buffer.from(row.authTag),
    };
    const value = key ? unseal(key, sealed, aadOf(row.id)) : undefined;
    if (value === undefined) {
      throw new SecretDecryptionFailedError();
    }
    return value;
  }

  async delete(reference: SecretReference): Promise<void> {
    if (isReference(reference)) {
      await this.database('delete', () => this.db.secret.deleteMany({ where: { id: reference } }));
    }
  }

  async listOlderThan(owner: SecretOwner, ageMs: number): Promise<SecretReference[]> {
    assertOwner(owner);
    if (!Number.isSafeInteger(ageMs) || ageMs < 0) {
      throw new RangeError('The secret age is invalid.');
    }
    // PostgreSQL's now(), the clock that stamped created_at, not the API's.
    const rows = await this.database(
      'listOlderThan',
      () =>
        this.db.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM secrets
        WHERE owner = ${owner} AND created_at <= now() - ${ageMs} * interval '1 millisecond'
        ORDER BY created_at, id`,
    );
    return rows.map((row) => row.id);
  }

  /**
   * Runs a database call; a failure becomes {@link SecretStoreUnavailableError}. The driver's
   * message can echo query arguments (the ciphertext), so only the error's name and code are
   * logged, and the original error is not attached as a cause.
   */
  private async database<T>(operation: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      this.logger.error(`Database call failed during ${operation}: ${describe(error)}`);
      throw new SecretStoreUnavailableError();
    }
  }
}

/** The error's class name and code, never its message. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'non-Error value';
  }
  const code: unknown = (error as { code?: unknown }).code;
  const name = LOGGABLE_CODE.test(error.name) ? error.name : 'Error';
  return typeof code === 'string' && LOGGABLE_CODE.test(code) ? `${name} (code ${code})` : name;
}

/** Refuses a malformed owner label before it reaches the database; the message is fixed. */
function assertOwner(owner: string): void {
  if (owner.length > OWNER_MAX_LENGTH || !OWNER.test(owner)) {
    throw new RangeError('The secret owner label is invalid.');
  }
}

/** Only a lower-case UUID can name a stored secret; anything else is never sent to the database. */
function isReference(reference: string): boolean {
  return REFERENCE.test(reference);
}

/** The reference as AAD: a sealed value opens only under the row id it was sealed for. */
function aadOf(reference: SecretReference): Buffer {
  return Buffer.from(reference, 'utf8');
}
