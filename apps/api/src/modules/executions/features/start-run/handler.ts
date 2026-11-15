import { Inject, Injectable } from '@nestjs/common';
import { RUN_START_POINTS, type RunStartPoints } from '../../../projects/contracts/index.js';
import {
  type Provider,
  RepositoryNotReadyError,
  type Run,
  RunProjectNotFoundError,
} from '../../domain/entities/run.js';
import { RUN_REPOSITORY, type RunRepository } from '../../domain/repositories/run-repository.js';
import {
  PROVIDER_UNAVAILABLE_REASONS,
  providerAvailability,
  ProviderUnavailableError,
} from '../../domain/services/provider-availability.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

export interface StartRunInput {
  projectId: string;
  provider: Provider;
  /** Validated by the caller (1–20 000 characters). */
  task: string;
}

/**
 * Command (Issue #96): queues a Run of a project from the current commit of its integration
 * branch, which `projects` provides through its public contract. It refuses a provider Studio
 * knows to be unavailable from the latest agent worker status (Issue #101); the worker's own
 * check stays authoritative. Throws {@link RunProjectNotFoundError},
 * {@link RepositoryNotReadyError} or {@link ProviderUnavailableError}.
 */
@Injectable()
export class StartRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_START_POINTS) private readonly startPoints: RunStartPoints,
    @Inject(WORKER_STATUS_STORE) private readonly statuses: WorkerStatusStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
  ) {}

  async execute(input: StartRunInput): Promise<Run> {
    const startPoint = await this.startPoints.forProject(input.projectId);
    switch (startPoint.status) {
      case 'project_not_found':
        throw new RunProjectNotFoundError();
      case 'no_repository':
        throw new RepositoryNotReadyError('no_repository');
      case 'repository_not_ready':
        throw new RepositoryNotReadyError('not_ready');
      case 'ready':
        this.assertAvailable(input.provider);
        return this.runs.add({
          ...input,
          startCommit: startPoint.startCommit,
          remoteUrl: startPoint.remoteUrl,
          integrationBranch: startPoint.integrationBranch,
        });
    }
  }

  private assertAvailable(provider: Provider): void {
    const availability = providerAvailability(
      this.statuses.latest(),
      this.clock.now(),
      this.lease.seconds,
    ).find((candidate) => candidate.id === provider);
    if (!availability || availability.reason) {
      throw new ProviderUnavailableError(
        provider,
        availability?.reason ?? PROVIDER_UNAVAILABLE_REASONS.switchedOff,
      );
    }
  }
}
