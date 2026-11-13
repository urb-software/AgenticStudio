import type { AppConfig } from '../config/config.js';
import { seal } from './aes-256-gcm.js';
import type { SecretStore } from './secret-store.js';

interface Db {
  secret: { create(args: { data: { ciphertext: string } }): Promise<{ id: string }> };
}

// Inside platform/secrets: the delegate, raw SQL and the key are all allowed here.
export class PrismaSecretStore implements SecretStore {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  async put(value: string): Promise<string> {
    const row = await this.db.secret.create({
      data: { ciphertext: seal(this.config.secretsKey, value) },
    });
    return row.id;
  }

  static readonly COUNT_SQL = 'SELECT count(*) FROM secrets';
}
