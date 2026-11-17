import { Injectable } from '@nestjs/common';
import type { UnfinishedJob } from '../../domain/value-objects/repository-failure.js';
import { CloneRepositoryHandler } from '../../application/features/clone-repository/handler.js';
import { FetchCloneHandler } from '../../application/features/fetch-clone/handler.js';
import { GetRepositoryOperationHandler } from '../../application/features/get-repository-operation/handler.js';
import { RepositoryStartupRecovery } from '../startup/repository-startup-recovery.js';

/**
 * Entry point: the processor of the Repository's background jobs. The queue adapter delivers
 * each job's events here; this decides which handler a job belongs to and invokes it, and holds
 * no rule of its own. The Repository's state says which operation a job runs (it asks
 * `get-repository-operation`): `connecting` runs the clone (`clone-repository`), `fetching`
 * runs the fetch (`fetch-clone`); a job of a Repository in any other state does nothing.
 * Start-up reconciliation is {@link RepositoryStartupRecovery}.
 */
@Injectable()
export class RepositoryJobProcessor {
  constructor(
    private readonly operations: GetRepositoryOperationHandler,
    private readonly clone: CloneRepositoryHandler,
    private readonly fetchClone: FetchCloneHandler,
    private readonly recovery: RepositoryStartupRecovery,
  ) {}

  async process(projectId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const operation = await this.operations.execute(projectId);
    if (operation === 'clone') return this.clone.process(projectId, signal);
    if (operation === 'fetch') return this.fetchClone.process(projectId, signal);
    // Otherwise a job left over from before a restart, whose attempt reconciliation failed.
  }

  async onFailed(projectId: string, failure: UnfinishedJob): Promise<void> {
    const operation = await this.operations.execute(projectId);
    if (operation === 'clone') return this.clone.onFailed(projectId, failure);
    if (operation === 'fetch') return this.fetchClone.onFailed(projectId, failure);
  }

  reconcile(): Promise<void> {
    return this.recovery.run();
  }
}
