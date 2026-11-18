import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import {
  type RunTransactionRepositories,
  type RunTransactions,
} from '../../application/ports/run-transactions.js';
import { isRunId } from '../../domain/value-objects/run-id.js';
import { PrismaPreparedFollowUpRepository } from '../repositories/prisma-prepared-follow-up-repository.js';
import { PrismaReviewCommentRepository } from '../repositories/prisma-review-comment-repository.js';
import { PrismaRunDiffRepository } from '../repositories/prisma-run-diff-repository.js';
import { PrismaRunLookupRepository } from '../repositories/prisma-run-lookup-repository.js';
import { PrismaRunRepository } from '../repositories/prisma-run-repository.js';
import { RunNotFoundError } from '../../domain/errors/run-errors.js';

/** Generous limits: a transaction waits for the Run's row lock. */
const TRANSACTION = { maxWait: 10_000, timeout: 15_000 } as const;

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
