import type { RunTransactionRepositories, RunTransactions } from '../run-transactions.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

/**
 * In-memory {@link RunTransactions}: the fakes change synchronously, so only the per-Run row lock
 * is simulated.
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
