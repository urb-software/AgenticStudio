import type { Prisma } from '@agentic-studio/database';
import type { DatabaseClient } from '../../../../platform/database/database.module.js';

export type Executor = DatabaseClient | Prisma.TransactionClient;

/** On a client already in a transaction, runs directly on it: interactive transactions do not nest. */
export function inTransaction<T>(
  db: Executor,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number },
): Promise<T> {
  return '$transaction' in db ? db.$transaction(work, options) : work(db);
}
