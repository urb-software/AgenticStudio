import { Injectable } from '@nestjs/common';
import { FailInterruptedClonesHandler } from '../../application/features/fail-interrupted-clones/handler.js';
import { FailInterruptedFetchesHandler } from '../../application/features/fail-interrupted-fetches/handler.js';
import { ResumeDisconnectsHandler } from '../../application/features/resume-disconnects/handler.js';
import { SweepOrphanedDeployKeysHandler } from '../../application/features/sweep-orphaned-deploy-keys/handler.js';
import { SweepOrphanedEnvironmentFilesHandler } from '../../application/features/sweep-orphaned-environment-files/handler.js';

/**
 * Repairs the Repository state at start-up, after the Git adapter's sweep (it must finish
 * before any Git job) and before the queue's worker starts; the handlers hold the rules.
 */
@Injectable()
export class RepositoryStartupRecovery {
  constructor(
    private readonly failInterruptedClones: FailInterruptedClonesHandler,
    private readonly failInterruptedFetches: FailInterruptedFetchesHandler,
    private readonly resumeDisconnects: ResumeDisconnectsHandler,
    private readonly orphanedKeys: SweepOrphanedDeployKeysHandler,
    private readonly orphanedEnvironmentFiles: SweepOrphanedEnvironmentFilesHandler,
  ) {}

  async run(): Promise<void> {
    await this.failInterruptedClones.execute();
    await this.failInterruptedFetches.execute();
    await this.resumeDisconnects.execute();
    await this.orphanedKeys.execute();
    await this.orphanedEnvironmentFiles.execute();
  }
}
