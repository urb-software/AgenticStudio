interface Db {
  $queryRawUnsafe(sql: string): Promise<unknown[]>;
}

// Forbidden: raw SQL on the secrets table, past the SecretStore port.
export class PrismaProjectRepository {
  constructor(private readonly db: Db) {}

  sealedSecrets(): Promise<unknown[]> {
    return this.db.$queryRawUnsafe('COPY secrets TO STDOUT');
  }
}
