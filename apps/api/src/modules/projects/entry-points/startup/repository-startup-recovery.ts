import { Injectable } from '@nestjs/common';
import { CloneRepositoryHandler } from '../../application/features/clone-repository/handler.js';
import { DisconnectRepositoryHandler } from '../../application/features/disconnect-repository/handler.js';
import { FetchCloneHandler } from '../../application/features/fetch-clone/handler.js';
import { SweepOrphanedDeployKeysHandler } from '../../application/features/sweep-orphaned-deploy-keys/handler.js';
import { SweepOrphanedEnvironmentFilesHandler } from '../../application/features/sweep-orphaned-environment-files/handler.js';

/**
 * Repairs the Repository state at start-up, after the Git adapter's sweep (it must finish
 * before any Git job) and before the queue's worker starts; the handlers hold the rules.
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
    await this.orphanedKeys.execute();
    await this.orphanedEnvironmentFiles.execute();
  }
}
