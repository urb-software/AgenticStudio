import { type KeyObject, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { DATABASE_CLIENT, type DatabaseClient } from '../database/database.module.js';
import { seal, unseal } from './aes-256-gcm.js';
import {
  SecretDecryptionFailedError,
  SecretNotFoundError,
  type SecretReference,
  type SecretStore,
} from './secret-store.js';

/** Version of `STUDIO_SECRETS_KEY`, stored with every row; the only one until rotation exists. */
export const CURRENT_KEY_VERSION = 1;

const REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The PostgreSQL adapter of the {@link SecretStore} (ADR 0001): AES-256-GCM with a fresh
 * random nonce per value, the reference bound as additional authenticated data, and the key
 * version stored per row. The only code that handles ciphertext or the master key.
 */
@Injectable()
export class PrismaSecretStore implements SecretStore {
  /** Master keys by version. A row whose version is missing here fails closed. */
  private readonly keys: ReadonlyMap<number, KeyObject>;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: DatabaseClient,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.keys = new Map([[CURRENT_KEY_VERSION, config.secretsKey]]);
  }

  async put(value: string): Promise<SecretReference> {
    const id = randomUUID();
    const sealed = seal(this.keys.get(CURRENT_KEY_VERSION)!, value, aadOf(id));
    await this.db.secret.create({
      data: {
        id,
        ciphertext: new Uint8Array(sealed.ciphertext),
        nonce: new Uint8Array(sealed.nonce),
        authTag: new Uint8Array(sealed.authTag),
        keyVersion: CURRENT_KEY_VERSION,
      },
    });
    return id;
  }

  async get(reference: SecretReference): Promise<string> {
    const row = isReference(reference)
      ? await this.db.secret.findUnique({ where: { id: reference } })
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
      await this.db.secret.deleteMany({ where: { id: reference } });
    }
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
