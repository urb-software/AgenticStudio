import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from './generated/prisma/client.js';

export type DatabaseClient = PrismaClient;

/**
 * Creates a Prisma client backed by the PostgreSQL driver adapter. The client
 * connects lazily on the first query; the caller owns its lifecycle and must call
 * `$disconnect()` on shutdown.
 */
export function createDatabaseClient(connectionString: string): DatabaseClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/** Whether a client call failed on a unique constraint (Prisma error P2002). */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
