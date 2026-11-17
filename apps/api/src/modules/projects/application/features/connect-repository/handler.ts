import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import { isProjectId } from '../../../domain/entities/project.js';
import {
  NOT_STARTED_DETAIL,
  type RepositoryConnection,
  repositoryFailure,
} from '../../../domain/entities/repository.js';
import {
  PROJECT_REPOSITORY,
  ProjectNotFoundError,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import { IntegrationBranch } from '../../../domain/value-objects/integration-branch.js';
import { RepositoryUrl } from '../../../domain/value-objects/repository-url.js';
import { gitHostName } from '../../../domain/value-objects/trusted-host-keys.js';
import { REPOSITORY_JOBS, type RepositoryJobs } from '../../ports/repository-jobs.js';
import { REPOSITORY_GIT, type RepositoryGit } from '../../ports/repository-git.js';
import { DEPLOY_KEYS, type DeployKeys, type StoredDeployKey } from '../../ports/deploy-keys.js';

/** DI token for {@link ConnectRepositorySettings}. */
export const CONNECT_REPOSITORY_SETTINGS = Symbol('CONNECT_REPOSITORY_SETTINGS');

export interface ConnectRepositorySettings {
  /** The test-only fixture-remote setting (`STUDIO_GIT_ALLOW_FILE_REMOTES`, NODE_ENV=test only). */
  allowFileRemotes: boolean;
  /** `STUDIO_GIT_ALLOW_PRIVATE_REMOTES` (Issue #69): an IP-literal URL may name a loopback or private address. */
  allowPrivateRemotes: boolean;
}

export interface ConnectRepositoryInput {
  projectId: string;
  url: string;
  integrationBranch: string;
}

/**
 * Command: Connect (glossary). Over HTTPS, stores the Repository as `connecting` and
 * schedules the background clone; returns at once. Over SSH (Issue #62), stores it as
 * `awaiting_key` with the project's Deploy key and schedules nothing: the operator adds the
 * public key on the Git host, then verifies (`verify-repository`). A Retry of a failed SSH
 * Repository keeps its Deploy key (and its pinned host key while the host stays the same); a
 * new key is generated otherwise, and a key no longer used is deleted. Order: input (field errors on every platform), platform,
 * the store's transition (the real duplicate guard), then the job. If the job cannot be
 * scheduled after the transition, the attempt is marked `failed` again (keeping the reason and
 * detail of the failure a Retry with the same URL and branch replaced, else "could not be
 * started") and the error is
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
    @Inject(DEPLOY_KEYS) private readonly deployKeys: DeployKeys,
  ) {}

  private readonly logger = new Logger('ConnectRepository');

  async execute(input: ConnectRepositoryInput): Promise<RepositoryConnection> {
    if (!isProjectId(input.projectId)) throw new ProjectNotFoundError();
    const url = RepositoryUrl.parse(input.url, {
      allowFileRemotes: this.settings.allowFileRemotes,
      addressPolicy: { allowPrivate: this.settings.allowPrivateRemotes },
    });
    const branch = IntegrationBranch.parse(input.integrationBranch);
    this.git.assertSupported();

    // A Retry replaces a failed Repository; if the clone cannot be scheduled with the same
    // settings, its failure is kept (with others, it would describe another attempt).
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
      url.ssh !== null && previous !== null && gitHostName(previous.url) === gitHostName(url.value);

    let repository: RepositoryConnection;
    try {
      repository = await this.projects.beginConnect({
        projectId: input.projectId,
        url: url.value,
        identity: url.identity,
        integrationBranch: branch.value,
        deployKey,
        pinnedHostKey: deployKey && samePinnedHost ? (previous?.pinnedHostKey ?? null) : null,
        keepsDeployKey: previousKey !== null && deployKey === previousKey,
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
      const sameSettings =
        previous?.url === url.value && previous.integrationBranch === branch.value;
      await this.projects.markFailed(
        input.projectId,
        previous?.state === 'failed' && previous.failure && sameSettings
          ? previous.failure
          : repositoryFailure('unknown', NOT_STARTED_DETAIL),
      );
      throw error;
    }
    return repository;
  }

  /**
   * Deletes a Deploy key no Repository references; a failure is logged (redacted), not thrown:
   * the orphaned-key sweep (Issue #76) deletes the key at a later start-up, once it is past its
   * grace period.
   */
  private async deleteKey(projectId: string, secretRef: string): Promise<void> {
    try {
      await this.deployKeys.remove(secretRef);
    } catch (error) {
      this.logger.warn(
        `Connect of project ${projectId}: could not delete an unused Deploy key. ${redactSecrets(String(error))}`,
      );
    }
  }
}
