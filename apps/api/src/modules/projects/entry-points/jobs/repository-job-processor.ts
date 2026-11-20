import { Injectable } from '@nestjs/common';
import type { UnfinishedJob } from '../../domain/value-objects/unfinished-job.js';
import { CloneRepositoryHandler } from '../../application/features/clone-repository/handler.js';
import { FetchCloneHandler } from '../../application/features/fetch-clone/handler.js';
import { RecordUnfinishedCloneHandler } from '../../application/features/record-unfinished-clone/handler.js';
import { RecordUnfinishedFetchHandler } from '../../application/features/record-unfinished-fetch/handler.js';
import { GetRepositoryOperationHandler } from '../../application/features/get-repository-operation/handler.js';
import { RepositoryStartupRecovery } from '../startup/repository-startup-recovery.js';

/**
 * Routes the queue's job events to a handler by the Repository's state: `connecting` clones,
 * `fetching` fetches, any other state does nothing.
 */
@Injectable()
export class RepositoryJobProcessor {
  constructor(
    private readonly operations: GetRepositoryOperationHandler,
    private readonly clone: CloneRepositoryHandler,
    private readonly fetchClone: FetchCloneHandler,
    private readonly recordUnfinishedClone: RecordUnfinishedCloneHandler,
    private readonly recordUnfinishedFetch: RecordUnfinishedFetchHandler,
    private readonly recovery: RepositoryStartupRecovery,
  ) {}

  async process(projectId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const operation = await this.operations.execute({ projectId });
    if (operation === 'clone') return this.clone.execute({ projectId, signal });
    if (operation === 'fetch') return this.fetchClone.execute({ projectId, signal });
    // Otherwise a job left over from before a restart, whose attempt reconciliation failed.
  }

  async onFailed(projectId: string, failure: UnfinishedJob): Promise<void> {
    const operation = await this.operations.execute({ projectId });
    if (operation === 'clone') return this.recordUnfinishedClone.execute({ projectId, failure });
    if (operation === 'fetch') return this.recordUnfinishedFetch.execute({ projectId, failure });
  }

  reconcile(): Promise<void> {
    return this.recovery.run();
  }
}
