interface Db {
  secret: { findMany(): Promise<{ ciphertext: Uint8Array }[]> };
}

// Forbidden: reading sealed secrets past the SecretStore port.
export class PrismaProjectRepository {
  constructor(private readonly db: Db) {}

  sealedSecrets(): Promise<{ ciphertext: Uint8Array }[]> {
    return this.db.secret.findMany();
  }
}
