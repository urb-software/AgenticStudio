import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export type DatabaseClient = PrismaClient;

/**
 * Creates a Prisma client backed by the PostgreSQL driver adapter. The client
 * connects lazily on the first query; the caller owns its lifecycle and must call
 * `$disconnect()` on shutdown.
 */
export function createDatabaseClient(connectionString: string): DatabaseClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
