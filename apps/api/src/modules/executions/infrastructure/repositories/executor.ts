import type { Prisma } from '@agentic-studio/database';
import type { DatabaseClient } from '../../../../platform/database/database.module.js';

/**
 * What a repository reads and writes through: the database client, or the client of a transaction
 * the module's `RunTransactions` opened (the same repository code then runs inside it).
 */
export type Executor = DatabaseClient | Prisma.TransactionClient;

/**
 * Runs `work` in a transaction: a new one on the database client, or directly on the client of a
 * transaction that is open already (interactive transactions do not nest).
 */
export function inTransaction<T>(
  db: Executor,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number },
): Promise<T> {
  return '$transaction' in db ? db.$transaction(work, options) : work(db);
}
