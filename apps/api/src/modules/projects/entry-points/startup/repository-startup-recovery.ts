import { Injectable } from '@nestjs/common';
import { CloneRepositoryHandler } from '../../application/features/clone-repository/handler.js';
import { DisconnectRepositoryHandler } from '../../application/features/disconnect-repository/handler.js';
import { FetchCloneHandler } from '../../application/features/fetch-clone/handler.js';
import { SweepOrphanedDeployKeysHandler } from '../../application/features/sweep-orphaned-deploy-keys/handler.js';
import { SweepOrphanedEnvironmentFilesHandler } from '../../application/features/sweep-orphaned-environment-files/handler.js';

/**
 * Entry point: what the API repairs at start-up. The platform runs it when the repository
 * queue is reconciled: after the Git adapter's start-up sweep (`onModuleInit`), which must
 * finish before any Git job (#60 clarification 11), and before the queue's worker starts.
 *
 * In this order: every Repository still `connecting` or `fetching` fails as interrupted
 * (`clone-repository`, `fetch-clone`); the Disconnect of every Repository still `disconnecting`
 * is resumed (`disconnect-repository`, #63); then the Deploy keys no Repository references
 * (`sweep-orphaned-deploy-keys`, #76) and the Environment file contents no project references
 * (`sweep-orphaned-environment-files`, #104) are deleted. Every rule lives in the handlers.
 */
@Injectable()
export class RepositoryStartupRecovery {
  constructor(
    private readonly clone: CloneRepositoryHandler,
    private readonly fetchClone: FetchCloneHandler,
    private readonly disconnect: DisconnectRepositoryHandler,
    private readonly orphanedKeys: SweepOrphanedDeployKeysHandler,
    private readonly orphanedEnvironmentFiles: SweepOrphanedEnvironmentFilesHandler,
  ) {}

  async run(): Promise<void> {
    await this.clone.reconcile();
    await this.fetchClone.reconcile();
    await this.disconnect.resumeAll();
    await this.orphanedKeys.sweep();
    await this.orphanedEnvironmentFiles.sweep();
  }
}
