import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { isProjectId } from '../../domain/entities/project.js';
import { type RepositoryConnection, repositoryFailure } from '../../domain/entities/repository.js';
import {
  PROJECT_REPOSITORY,
  ProjectNotFoundError,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';
import { IntegrationBranch } from '../../domain/value-objects/integration-branch.js';
import { RepositoryUrl } from '../../domain/value-objects/repository-url.js';
import { REPOSITORY_JOBS, type RepositoryJobs } from '../../ports/repository-jobs.js';
import { REPOSITORY_GIT, type RepositoryGit } from '../../ports/repository-git.js';
import { DeployKeyHandler, type StoredDeployKey } from '../deploy-key/handler.js';
import { SweepOrphanedDeployKeysHandler } from '../sweep-orphaned-deploy-keys/handler.js';

/** DI token for {@link ConnectRepositorySettings}. */
export const CONNECT_REPOSITORY_SETTINGS = Symbol('CONNECT_REPOSITORY_SETTINGS');

export interface ConnectRepositorySettings {
  /** The test-only fixture-remote setting (`STUDIO_GIT_ALLOW_FILE_REMOTES`, NODE_ENV=test only). */
  allowFileRemotes: boolean;
}

export interface ConnectRepositoryInput {
  projectId: string;
  url: string;
  integrationBranch: string;
}

/** Stored on the Repository when the clone could not be scheduled after it was stored. */
export const NOT_STARTED_DETAIL = 'The clone could not be started. Try again.';

/**
 * Command: Connect (glossary). Over HTTPS, stores the Repository as `connecting` and
 * schedules the background clone; returns at once. Over SSH (Issue #62), stores it as
 * `awaiting_key` with the project's Deploy key and schedules nothing: the operator adds the
 * public key on the Git host, then verifies (`verify-repository`). A Retry of a failed SSH
 * Repository keeps its Deploy key (and its pinned host key while the host stays the same); a
 * new key is generated otherwise, and a key no longer used is deleted. Order: input (field errors on every platform), platform,
 * the store's transition (the real duplicate guard), then the job. If the job cannot be
 * scheduled after the transition, the attempt is marked `failed` again (keeping the reason and
 * detail of the failure a Retry replaced, else "could not be started") and the error is
 * rethrown, so nothing stays `connecting`.
 *
 * Throws `GitUnsupportedPlatformError`, `InvalidRepositoryUrlError`,
 * `InvalidIntegrationBranchError`, {@link ProjectNotFoundError}, the store's conflict
 * errors, and the queue's `JobAlreadyActiveError` / `QueueUnavailableError`.
 */
@Injectable()
export class ConnectRepositoryHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(REPOSITORY_JOBS) private readonly jobs: RepositoryJobs,
    @Inject(CONNECT_REPOSITORY_SETTINGS) private readonly settings: ConnectRepositorySettings,
    private readonly deployKeys: DeployKeyHandler,
    private readonly orphanedKeys: SweepOrphanedDeployKeysHandler,
  ) {}

  private readonly logger = new Logger('ConnectRepository');

  async execute(input: ConnectRepositoryInput): Promise<RepositoryConnection> {
    if (!isProjectId(input.projectId)) throw new ProjectNotFoundError();
    const url = RepositoryUrl.parse(input.url, {
      allowFileRemotes: this.settings.allowFileRemotes,
    });
    const branch = IntegrationBranch.parse(input.integrationBranch);
    this.git.assertSupported();

    // A Retry replaces a failed Repository; if the clone cannot be scheduled, its failure is kept.
    const previous = await this.projects.findRepository(input.projectId);
    const previousKey: StoredDeployKey | null =
      previous?.state === 'failed' && previous.deployKeySecret && previous.publicKey
        ? { secretRef: previous.deployKeySecret, publicKey: previous.publicKey }
        : null;

    let deployKey: StoredDeployKey | null = null;
    let createdKey = false;
    if (url.ssh) {
      if (previousKey) {
        deployKey = previousKey;
      } else {
        const project = await this.projects.findById(input.projectId);
        if (!project) throw new ProjectNotFoundError();
        deployKey = await this.deployKeys.create(project.name);
        createdKey = true;
      }
    }
    const samePinnedHost =
      url.ssh !== null &&
      previous !== null &&
      this.deployKeys.hostNameOf(previous.url) === this.deployKeys.hostNameOf(url.value);

    let repository: RepositoryConnection;
    try {
      repository = await this.projects.beginConnect({
        projectId: input.projectId,
        url: url.value,
        identity: url.identity,
        integrationBranch: branch.value,
        deployKey,
        pinnedHostKey: deployKey && samePinnedHost ? (previous?.pinnedHostKey ?? null) : null,
      });
    } catch (error) {
      if (createdKey && deployKey) await this.deleteKey(input.projectId, deployKey.secretRef);
      throw error;
    }
    // The replaced Repository's key is no longer referenced (it was replaced over HTTPS).
    if (previousKey && previousKey !== deployKey) {
      await this.deleteKey(input.projectId, previousKey.secretRef);
    }
    if (url.ssh) return repository;
    try {
      await this.jobs.start(input.projectId, 'clone');
    } catch (error) {
      await this.projects.markFailed(
        input.projectId,
        previous?.state === 'failed' && previous.failure
          ? previous.failure
          : repositoryFailure('unknown', NOT_STARTED_DETAIL),
      );
      throw error;
    }
    return repository;
  }

  /**
   * Deletes a Deploy key no Repository references; a failure is logged (redacted), not thrown,
   * and followed by an orphan sweep (Issue #76), which deletes the key once it is past the
   * sweep's grace period, if not now then at a later sweep.
   */
  private async deleteKey(projectId: string, secretRef: string): Promise<void> {
    try {
      await this.deployKeys.delete(secretRef);
    } catch (error) {
      this.logger.warn(
        `Connect of project ${projectId}: could not delete an unused Deploy key. ${redactSecrets(String(error))}`,
      );
      await this.orphanedKeys.sweep();
    }
  }
}
