import type { RunTransactionRepositories, RunTransactions } from '../run-transactions.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

/**
 * In-memory adapter of {@link RunTransactions} for handler tests: it hands the in-memory
 * repositories to the callback when the Run exists. The fakes change synchronously and a
 * callback that throws before it saves has changed nothing, so there is no rollback to
 * simulate beyond the lock; the lock order and the atomicity are proved against PostgreSQL by
 * the integration and race tests. Transactions on one Run run one after the other, as the row
 * lock makes them.
 */
export class InMemoryRunTransactions implements RunTransactions {
  /** The end of the line of transactions on each Run: the Run's row lock. */
  private readonly lines = new Map<string, Promise<unknown>>();

  constructor(private readonly repositories: RunTransactionRepositories) {}

  async withRunLocked<T>(
    runId: string,
    work: (repositories: RunTransactionRepositories) => Promise<T>,
  ): Promise<T> {
    // Like the row lock, one transaction on a Run at a time, the next one after the last.
    const previous = this.lines.get(runId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        if (!(await this.repositories.runs.exists(runId))) throw new RunNotFoundError();
        return work(this.repositories);
      });
    this.lines.set(runId, run);
    return run;
  }
}
