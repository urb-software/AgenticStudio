import { describe, expect, it, vi } from 'vitest';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InMemoryEnvironmentFileRepository } from '../../../domain/repositories/__tests__/in-memory-environment-file-repository.js';
import { FakeRepositoryGit } from '../../../application/ports/__tests__/fake-repository-git.js';
import { InMemoryDeployKeys } from '../../../application/ports/__tests__/in-memory-deploy-keys.js';
import { InMemoryEnvironmentFileContents } from '../../../application/ports/__tests__/in-memory-environment-file-contents.js';
import { InMemorySecretStore } from '../../../application/ports/__tests__/in-memory-secret-store.js';
import { RecordingRepositoryJobs } from '../../../application/ports/__tests__/recording-repository-jobs.js';
import { CloneRepositoryHandler } from '../../../application/features/clone-repository/handler.js';
import { DisconnectRepositoryHandler } from '../../../application/features/disconnect-repository/handler.js';
import { FetchCloneHandler } from '../../../application/features/fetch-clone/handler.js';
import { SweepOrphanedDeployKeysHandler } from '../../../application/features/sweep-orphaned-deploy-keys/handler.js';
import { SweepOrphanedEnvironmentFilesHandler } from '../../../application/features/sweep-orphaned-environment-files/handler.js';
import { RepositoryStartupRecovery } from '../repository-startup-recovery.js';

describe('RepositoryStartupRecovery', () => {
  it('reconciles interrupted clones and fetches, resumes pending disconnects, then sweeps orphaned Deploy keys', async () => {
    const deployKeys = new InMemoryDeployKeys(new InMemorySecretStore());
    const projects = new InMemoryProjectRepository();
    const git = new FakeRepositoryGit();
    const clone = new CloneRepositoryHandler(projects, git, deployKeys);
    const fetchClone = new FetchCloneHandler(projects, git, deployKeys);
    vi.spyOn(clone, 'reconcile');
    vi.spyOn(fetchClone, 'reconcile');
    const cleanup = new DisconnectRepositoryHandler(
      projects,
      git,
      new RecordingRepositoryJobs(),
      deployKeys,
    );
    vi.spyOn(cleanup, 'resumeAll');
    const orphanedKeys = new SweepOrphanedDeployKeysHandler(projects, deployKeys, {
      gracePeriodMs: 0,
    });
    vi.spyOn(orphanedKeys, 'sweep');
    const orphanedFiles = new SweepOrphanedEnvironmentFilesHandler(
      new InMemoryEnvironmentFileRepository(),
      new InMemoryEnvironmentFileContents(),
    );
    vi.spyOn(orphanedFiles, 'sweep');
    const recovery = new RepositoryStartupRecovery(
      clone,
      fetchClone,
      cleanup,
      orphanedKeys,
      orphanedFiles,
    );

    await recovery.run();

    expect(clone.reconcile).toHaveBeenCalledOnce();
    expect(fetchClone.reconcile).toHaveBeenCalledOnce();
    expect(cleanup.resumeAll).toHaveBeenCalledOnce();
    expect(orphanedKeys.sweep).toHaveBeenCalledOnce();
    expect(orphanedFiles.sweep).toHaveBeenCalledOnce();
    const order = (spy: unknown) => vi.mocked(spy as () => unknown).mock.invocationCallOrder[0]!;
    expect(order(fetchClone.reconcile)).toBeGreaterThan(order(clone.reconcile));
    expect(order(cleanup.resumeAll)).toBeGreaterThan(order(fetchClone.reconcile));
    expect(order(orphanedKeys.sweep)).toBeGreaterThan(order(cleanup.resumeAll));
    expect(order(orphanedFiles.sweep)).toBeGreaterThan(order(orphanedKeys.sweep));
  });
});
