import { Inject, Injectable } from '@nestjs/common';
import { isProjectId } from '../../domain/entities/project.js';
import {
  isVerifiable,
  type RepositoryConnection,
  repositoryFailure,
} from '../../domain/entities/repository.js';
import {
  NoRepositoryError,
  PROJECT_REPOSITORY,
  ProjectNotFoundError,
  type ProjectRepository,
  RepositoryNotVerifiableError,
} from '../../domain/repositories/project-repository.js';
import { hostKeyFingerprint } from '../../domain/value-objects/ssh-key.js';
import { REPOSITORY_JOBS, type RepositoryJobs } from '../../ports/repository-jobs.js';
import {
  GitOperationError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';
import { NOT_STARTED_DETAIL } from '../connect-repository/handler.js';
import { DeployKeyHandler } from '../deploy-key/handler.js';

export interface VerifyRepositoryInput {
  projectId: string;
  /** The fingerprint the operator confirmed, when the Repository is `awaiting_host_key`. */
  acceptHostKeyFingerprint?: string;
}

/** The confirmed fingerprint is not the one of the host key awaiting confirmation. */
export class HostKeyFingerprintMismatchError extends Error {
  constructor() {
    super(
      'The fingerprint does not match the host key Studio retrieved. Verify again to retrieve the host key again.',
    );
    this.name = 'HostKeyFingerprintMismatchError';
  }
}

/** How long retrieving a host key may take; the request waits for it. */
export const HOST_KEY_SCAN_TIMEOUT_MS = 30_000;

const NOT_WAITING_FOR_HOST_KEY = 'No host key is waiting for confirmation. Verify again first.';

/**
 * Command: Verify and clone (Issue #62), for an SSH Repository that is `awaiting_key`,
 * `awaiting_host_key`, or `failed` without a Clone (Retry, with the same Deploy key).
 *
 * - A host whose key is trusted (listed in `STUDIO_SSH_KNOWN_HOSTS`, or pinned for this
 *   Repository) is cloned at once: `connecting`, and the background clone is scheduled.
 * - Any other host: Studio retrieves its host key (in the request, time-limited) and the
 *   Repository waits in `awaiting_host_key` for the operator to confirm its fingerprint; a
 *   host that cannot be reached leaves it `failed`.
 * - With `acceptHostKeyFingerprint`: it must equal the pending key's fingerprint exactly
 *   ({@link HostKeyFingerprintMismatchError} otherwise); the key is then pinned and the clone
 *   scheduled, in one conditional write that pins exactly the key the operator saw.
 *
 * As for connect, a clone that cannot be scheduled leaves the Repository `failed` and the
 * queue's error is rethrown. Throws {@link ProjectNotFoundError}, {@link NoRepositoryError},
 * `GitUnsupportedPlatformError`, {@link RepositoryNotVerifiableError},
 * {@link HostKeyFingerprintMismatchError} and the queue's errors.
 */
@Injectable()
export class VerifyRepositoryHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(REPOSITORY_JOBS) private readonly jobs: RepositoryJobs,
    private readonly deployKeys: DeployKeyHandler,
  ) {}

  async execute(input: VerifyRepositoryInput): Promise<RepositoryConnection> {
    const { projectId, acceptHostKeyFingerprint } = input;
    if (!isProjectId(projectId)) throw new ProjectNotFoundError();
    this.git.assertSupported();

    const repository = await this.projects.findRepository(projectId);
    if (!repository) {
      throw (await this.projects.findById(projectId))
        ? new NoRepositoryError()
        : new ProjectNotFoundError();
    }
    if (!isVerifiable(repository)) throw new RepositoryNotVerifiableError();

    if (acceptHostKeyFingerprint !== undefined) {
      const pending = repository.state === 'awaiting_host_key' ? repository.pendingHostKey : null;
      if (!pending) throw new RepositoryNotVerifiableError(NOT_WAITING_FOR_HOST_KEY);
      if (hostKeyFingerprint(pending) !== acceptHostKeyFingerprint) {
        throw new HostKeyFingerprintMismatchError();
      }
      return this.startClone(repository, { pendingHostKey: pending });
    }

    if (this.deployKeys.trustedHostKeys(repository).length > 0) {
      return this.startClone(repository, null);
    }

    let hostKey: string;
    try {
      ({ hostKey } = await this.git.scanHostKey(repository.url, {
        timeoutMs: HOST_KEY_SCAN_TIMEOUT_MS,
      }));
    } catch (error) {
      if (!(error instanceof GitOperationError)) throw error;
      await this.projects.failVerification(
        projectId,
        repositoryFailure(error.reason, error.detail),
      );
      return this.current(projectId);
    }
    const awaiting = await this.projects.awaitHostKey(projectId, hostKey);
    if (!awaiting) throw new RepositoryNotVerifiableError();
    return awaiting;
  }

  /**
   * → `connecting` (pinning a confirmed key), then schedules the clone. If it cannot be
   * scheduled, the Repository is `failed` again with the failure a Retry replaced (e.g.
   * `auth_failed` and its guidance), else "could not be started", as connect does.
   */
  private async startClone(
    previous: RepositoryConnection,
    confirmed: { pendingHostKey: string } | null,
  ): Promise<RepositoryConnection> {
    const { projectId } = previous;
    const started = await this.projects.beginVerifiedClone(projectId, confirmed);
    // Another request changed the Repository since it was read.
    if (!started) throw new RepositoryNotVerifiableError();
    try {
      await this.jobs.start(projectId, 'clone');
    } catch (error) {
      await this.projects.markFailed(
        projectId,
        previous.state === 'failed' && previous.failure
          ? previous.failure
          : repositoryFailure('unknown', NOT_STARTED_DETAIL),
      );
      throw error;
    }
    return started;
  }

  private async current(projectId: string): Promise<RepositoryConnection> {
    const repository = await this.projects.findRepository(projectId);
    if (!repository) throw new NoRepositoryError();
    return repository;
  }
}
