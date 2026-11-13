interface Db {
  secret: { findMany(): Promise<{ ciphertext: Uint8Array }[]> };
  $queryRawUnsafe(sql: string): Promise<unknown[]>;
}

// Forbidden: reading sealed secrets past the SecretStore port.
export class PrismaProjectRepository {
  constructor(private readonly db: Db) {}

  async sealedSecrets(): Promise<unknown[]> {
    return [
      ...(await this.db.secret.findMany()),
      ...(await this.db.$queryRawUnsafe('SELECT * FROM "secrets"')),
    ];
  }
}
