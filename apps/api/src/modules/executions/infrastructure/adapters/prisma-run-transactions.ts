import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import {
  type RunTransactionRepositories,
  type RunTransactions,
} from '../../application/ports/run-transactions.js';
import { RunNotFoundError } from '../../domain/repositories/run-repository.js';
import { isRunId } from '../../domain/entities/run.js';
import { PrismaPreparedFollowUpRepository } from '../repositories/prisma-prepared-follow-up-repository.js';
import { PrismaReviewCommentRepository } from '../repositories/prisma-review-comment-repository.js';
import { PrismaRunDiffRepository } from '../repositories/prisma-run-diff-repository.js';
import { PrismaRunLookupRepository } from '../repositories/prisma-run-lookup-repository.js';
import { PrismaRunRepository } from '../repositories/prisma-run-repository.js';

/** Generous limits, as the Run repository's own transactions: they wait for the Run's row lock. */
const TRANSACTION = { maxWait: 10_000, timeout: 15_000 } as const;

/**
 * PostgreSQL adapter of {@link RunTransactions}: one interactive transaction whose first statement
 * is the Run's `SELECT … FOR UPDATE`, with every repository of the module bound to that
 * transaction. It contains no rule: it opens the transaction, takes the lock and hands the bound
 * repositories to the caller's orchestration.
 */
@Injectable()
export class PrismaRunTransactions implements RunTransactions {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  withRunLocked<T>(
    runId: string,
    work: (repositories: RunTransactionRepositories) => Promise<T>,
  ): Promise<T> {
    if (!isRunId(runId)) return Promise.reject(new RunNotFoundError());
    return this.db.$transaction(async (tx) => {
      // Locks the Run row until commit: the first lock of every operation across aggregates.
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM runs WHERE id = ${runId}::uuid FOR UPDATE`;
      if (!locked) throw new RunNotFoundError();
      return work({
        runs: new PrismaRunRepository(tx),
        lookups: new PrismaRunLookupRepository(tx),
        reviewComments: new PrismaReviewCommentRepository(tx),
        preparedFollowUps: new PrismaPreparedFollowUpRepository(tx),
        diffs: new PrismaRunDiffRepository(tx),
      });
    }, TRANSACTION);
  }
}
