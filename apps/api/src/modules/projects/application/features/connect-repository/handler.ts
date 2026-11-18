import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import {
  RepositoryAlreadyConnectedError,
  RemoteAlreadyConnectedError,
  RemoteHeldByOtherProjectError,
} from '../../../domain/errors/repository-connection-errors.js';
import { RepositoryConnection } from '../../../domain/entities/repository-connection.js';
import { RepositoryFailure } from '../../../domain/value-objects/repository-failure.js';
import { type RepositoryConnectionSnapshot } from '../../../domain/entities/repository-connection-snapshot.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import { IntegrationBranch } from '../../../domain/value-objects/integration-branch.js';
import { RepositoryUrl } from '../../../domain/value-objects/repository-url.js';
import { REPOSITORY_JOBS, type RepositoryJobs } from '../../ports/repository-jobs.js';
import { REPOSITORY_GIT, type RepositoryGit } from '../../ports/repository-git.js';
import { DeployKeySweepPolicy } from '../../../domain/value-objects/deploy-key-sweep-policy.js';
import {
  DEPLOY_KEY_SWEEP_SETTINGS,
  DEPLOY_KEYS,
  type DeployKeys,
  type DeployKeySweepSettings,
  type StoredDeployKey,
} from '../../ports/deploy-keys.js';
import { ProjectNotFoundError } from '../../../domain/errors/project-errors.js';

export const CONNECT_REPOSITORY_SETTINGS = Symbol('CONNECT_REPOSITORY_SETTINGS');

export interface ConnectRepositorySettings {
  /** The test-only fixture-remote setting (`STUDIO_GIT_ALLOW_FILE_REMOTES`, NODE_ENV=test only). */
  allowFileRemotes: boolean;
  allowPrivateRemotes: boolean;
}

export interface ConnectRepositoryInput {
  projectId: string;
  url: string;
  integrationBranch: string;
}

export type ConnectRepositoryResult = RepositoryConnectionSnapshot;

/**
 * If the clone job cannot be scheduled, the attempt is failed again and the error rethrown, so
 * nothing stays `connecting`.
 */
@Injectable()
export class ConnectRepositoryHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(REPOSITORY_JOBS) private readonly jobs: RepositoryJobs,
    @Inject(CONNECT_REPOSITORY_SETTINGS) private readonly settings: ConnectRepositorySettings,
    @Inject(DEPLOY_KEYS) private readonly deployKeys: DeployKeys,
    @Inject(DEPLOY_KEY_SWEEP_SETTINGS) private readonly sweepSettings: DeployKeySweepSettings,
  ) {}

  private readonly logger = new Logger('ConnectRepository');
  private readonly sweepLogger = new Logger('DeployKeySweep');

  async execute(input: ConnectRepositoryInput): Promise<ConnectRepositoryResult> {
    if (!isProjectId(input.projectId)) throw new ProjectNotFoundError();
    const url = RepositoryUrl.parse(input.url, {
      allowFileRemotes: this.settings.allowFileRemotes,
      addressPolicy: { allowPrivate: this.settings.allowPrivateRemotes },
    });
    const branch = IntegrationBranch.parse(input.integrationBranch);
    this.git.assertSupported();

    // A Retry replaces a failed Repository; if the clone cannot be scheduled with the same
    // settings, its failure is kept (with others, it would describe another attempt).
    const previous = await this.repositories.find(input.projectId);
    const previousKey: StoredDeployKey | null = previous?.retainedDeployKey ?? null;

    // The Repository's store does not read the Project's table: the Project must exist, and a
    // missing one never leaves a created Deploy key behind.
    const project = await this.projects.findById(input.projectId);
    if (!project) throw new ProjectNotFoundError();

    let deployKey: StoredDeployKey | null = null;
    let createdKey = false;
    if (url.ssh) {
      if (previousKey) {
        deployKey = previousKey;
      } else {
        deployKey = await this.deployKeys.create(project.name);
        createdKey = true;
      }
    }

    let repository: RepositoryConnection;
    try {
      repository = await this.repositories.connect({
        projectId: input.projectId,
        url: url.value,
        identity: url.identity,
        integrationBranch: branch.value,
        deployKey,
        pinnedHostKey: deployKey ? (previous?.pinnedHostKeyFor(url.value) ?? null) : null,
        keepsDeployKey: previousKey !== null && deployKey === previousKey,
      });
    } catch (error) {
      if (createdKey && deployKey) await this.deleteKey(input.projectId, deployKey.secretRef);
      throw await this.nameRemoteOwner(error);
    }
    // The replaced Repository's key is no longer referenced (it was replaced over HTTPS).
    if (previousKey && previousKey !== deployKey) {
      await this.deleteKey(input.projectId, previousKey.secretRef);
    }
    if (url.ssh) return repository.snapshot();
    try {
      await this.jobs.start(input.projectId, 'clone');
    } catch (error) {
      const failure = RepositoryFailure.whenCloneNotScheduled(previous, {
        url: url.value,
        integrationBranch: branch.value,
      });
      await this.repositories.change(input.projectId, (stored) => {
        stored.failClone(failure);
      });
      throw error;
    }
    return repository.snapshot();
  }

  /**
   * The store names the Project that holds a remote by its id; the operator is told its name,
   * so the id is turned into it here. Any other error passes through.
   */
  private async nameRemoteOwner(error: unknown): Promise<unknown> {
    if (!(error instanceof RemoteHeldByOtherProjectError)) return error;
    const owner = await this.projects.findById(error.ownerProjectId);
    return owner
      ? new RemoteAlreadyConnectedError(owner.name)
      : new RepositoryAlreadyConnectedError();
  }

  /**
   * Deletes a Deploy key no Repository references; a failure is logged (redacted), not thrown,
   * and the orphan sweep deletes the key once it is past its grace period.
   */
  private async deleteKey(projectId: string, secretRef: string): Promise<void> {
    try {
      await this.deployKeys.remove(secretRef);
    } catch (error) {
      this.logger.warn(
        `Connect of project ${projectId}: could not delete an unused Deploy key. ${redactSecrets(String(error))}`,
      );
      await this.sweepOrphanedKeys();
    }
  }

  private async sweepOrphanedKeys(): Promise<void> {
    let orphans: string[];
    try {
      const policy = DeployKeySweepPolicy.of(this.sweepSettings.gracePeriodMs);
      const candidates = await this.deployKeys.listOlderThan(policy.gracePeriodMs);
      if (candidates.length === 0) return;
      orphans = policy.orphans(candidates, await this.repositories.listDeployKeySecretRefs());
    } catch (error) {
      this.sweepLogger.warn(
        `Could not sweep orphaned Deploy keys; the next sweep tries again. ${redactSecrets(String(error))}`,
      );
      return;
    }
    for (const secretRef of orphans) {
      try {
        await this.deployKeys.remove(secretRef);
        this.sweepLogger.log(`Deleted the orphaned Deploy key secret ${secretRef}.`);
      } catch (error) {
        this.sweepLogger.warn(
          `Could not delete the orphaned Deploy key secret ${secretRef}; the next sweep tries ` +
            `again. ${redactSecrets(String(error))}`,
        );
      }
    }
  }
}
