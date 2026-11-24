import { describe, expect, it, vi } from 'vitest';
import { InMemoryRepositoryConnectionRepository } from '../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import { InMemoryEnvironmentFileRepository } from '../../../domain/repositories/__tests__/in-memory-environment-file-repository.js';
import { FakeRepositoryGit } from '../../../application/ports/__tests__/fake-repository-git.js';
import { InMemoryDeployKeys } from '../../../application/ports/__tests__/in-memory-deploy-keys.js';
import { InMemoryEnvironmentFileContents } from '../../../application/ports/__tests__/in-memory-environment-file-contents.js';
import { InMemorySecretStore } from '../../../application/ports/__tests__/in-memory-secret-store.js';
import { RepositoryCleanup } from '../../../application/repository-cleanup.js';
import { InMemoryDisconnectSteps } from '../../../application/ports/__tests__/in-memory-disconnect-steps.js';
import { FailInterruptedClonesHandler } from '../../../application/features/fail-interrupted-clones/handler.js';
import { FailInterruptedFetchesHandler } from '../../../application/features/fail-interrupted-fetches/handler.js';
import { ResumeDisconnectsHandler } from '../../../application/features/resume-disconnects/handler.js';
import { SweepOrphanedDeployKeysHandler } from '../../../application/features/sweep-orphaned-deploy-keys/handler.js';
import { SweepOrphanedEnvironmentFilesHandler } from '../../../application/features/sweep-orphaned-environment-files/handler.js';
import { RepositoryStartupRecovery } from '../repository-startup-recovery.js';

describe('RepositoryStartupRecovery', () => {
  it('reconciles interrupted clones and fetches, resumes pending disconnects, then sweeps orphaned Deploy keys', async () => {
    const deployKeys = new InMemoryDeployKeys(new InMemorySecretStore());
    const connections = new InMemoryRepositoryConnectionRepository();
    const git = new FakeRepositoryGit();
    const failInterruptedClones = new FailInterruptedClonesHandler(connections);
    const failInterruptedFetches = new FailInterruptedFetchesHandler(connections);
    vi.spyOn(failInterruptedClones, 'execute');
    vi.spyOn(failInterruptedFetches, 'execute');
    const cleanup = new ResumeDisconnectsHandler(
      connections,
      new RepositoryCleanup(connections, git, deployKeys, new InMemoryDisconnectSteps()),
    );
    vi.spyOn(cleanup, 'execute');
    const orphanedKeys = new SweepOrphanedDeployKeysHandler(connections, deployKeys, {
      gracePeriodMs: 0,
    });
    vi.spyOn(orphanedKeys, 'execute');
    const orphanedFiles = new SweepOrphanedEnvironmentFilesHandler(
      new InMemoryEnvironmentFileRepository(),
      new InMemoryEnvironmentFileContents(),
    );
    vi.spyOn(orphanedFiles, 'execute');
    const recovery = new RepositoryStartupRecovery(
      failInterruptedClones,
      failInterruptedFetches,
      cleanup,
      orphanedKeys,
      orphanedFiles,
    );

    await recovery.run();

    expect(failInterruptedClones.execute).toHaveBeenCalledOnce();
    expect(failInterruptedFetches.execute).toHaveBeenCalledOnce();
    expect(cleanup.execute).toHaveBeenCalledOnce();
    expect(orphanedKeys.execute).toHaveBeenCalledOnce();
    expect(orphanedFiles.execute).toHaveBeenCalledOnce();
    const order = (spy: unknown) => vi.mocked(spy as () => unknown).mock.invocationCallOrder[0]!;
    expect(order(failInterruptedFetches.execute)).toBeGreaterThan(
      order(failInterruptedClones.execute),
    );
    expect(order(cleanup.execute)).toBeGreaterThan(order(failInterruptedFetches.execute));
    expect(order(orphanedKeys.execute)).toBeGreaterThan(order(cleanup.execute));
    expect(order(orphanedFiles.execute)).toBeGreaterThan(order(orphanedKeys.execute));
  });
});
