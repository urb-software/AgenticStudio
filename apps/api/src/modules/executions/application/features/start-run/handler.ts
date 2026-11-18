import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RUN_START_POINTS, type RunStartPoints } from '../../../../projects/contracts/index.js';
import { type Provider } from '../../../domain/value-objects/provider.js';
import {
  RepositoryNotReadyError,
  RunProjectNotFoundError,
  ProviderUnavailableError,
} from '../../../domain/errors/run-errors.js';
import { Run } from '../../../domain/entities/run.js';
import { type RunSnapshot } from '../../../domain/entities/run-snapshot.js';
import { Task } from '../../../domain/value-objects/task.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import {
  PROVIDER_UNAVAILABLE_REASONS,
  WorkerStatus,
} from '../../../domain/value-objects/worker-status.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RUN_LIMITS, type RunLimitsSetting } from '../../ports/run-limits.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

export interface StartRunInput {
  projectId: string;
  provider: Provider;
  task: string;
}

export interface StartRunResult {
  run: RunSnapshot;
}

/**
 * Refuses a provider known to be unavailable from the latest worker status; the worker's own check stays authoritative.
 * Throws {@link RunProjectNotFoundError}, {@link RepositoryNotReadyError}, {@link ProviderUnavailableError} or `InvalidTaskError`.
 */
@Injectable()
export class StartRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_START_POINTS) private readonly startPoints: RunStartPoints,
    @Inject(WORKER_STATUS_STORE) private readonly statuses: WorkerStatusStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
    @Inject(RUN_LIMITS) private readonly limits: RunLimitsSetting,
  ) {}

  async execute(input: StartRunInput): Promise<StartRunResult> {
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
        return {
          run: (
            await this.runs.add(
              Run.start({
                id: randomUUID(),
                projectId: input.projectId,
                provider: input.provider,
                task: Task.of(input.task),
                startCommit: startPoint.startCommit,
                remoteUrl: startPoint.remoteUrl,
                integrationBranch: startPoint.integrationBranch,
                limits: { ...this.limits },
                now: this.clock.now(),
              }),
            )
          ).snapshot(),
        };
    }
  }

  private assertAvailable(provider: Provider): void {
    const availability = WorkerStatus.providerAvailability(
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
