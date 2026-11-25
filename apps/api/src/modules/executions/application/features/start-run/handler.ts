import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  PROJECT_KINDS,
  type ProjectKinds,
  RUN_START_POINTS,
  type RunStartPoints,
} from '../../../../projects/contracts/index.js';
import { type Provider } from '../../../domain/value-objects/provider.js';
import {
  DefinitionsProjectRunError,
  RepositoryNotReadyError,
  RunProjectNotFoundError,
  ProviderUnavailableError,
} from '../../../domain/errors/run-errors.js';
import { Run } from '../../../domain/entities/run.js';
import { Task } from '../../../domain/value-objects/task.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { PROVIDER_UNAVAILABLE_REASONS } from '../../../domain/value-objects/provider-unavailable-reason.js';
import { Lease } from '../../../domain/value-objects/lease.js';
import { WorkerPresence } from '../../../domain/value-objects/worker-presence.js';
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
  id: string;
}

/**
 * Refuses a provider known to be unavailable from the latest worker status; the worker's own check
 * stays authoritative. Throws {@link RunProjectNotFoundError}, {@link DefinitionsProjectRunError}, {@link RepositoryNotReadyError},
 * {@link ProviderUnavailableError} or `InvalidTaskError`.
 */
@Injectable()
export class StartRunHandler {
  constructor(
    @Inject(PROJECT_KINDS) private readonly kinds: ProjectKinds,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_START_POINTS) private readonly startPoints: RunStartPoints,
    @Inject(WORKER_STATUS_STORE) private readonly statuses: WorkerStatusStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
    @Inject(RUN_LIMITS) private readonly limits: RunLimitsSetting,
  ) {}

  async execute(input: StartRunInput): Promise<StartRunResult> {
    if ((await this.kinds.kindOf(input.projectId)) === 'definitions') {
      throw new DefinitionsProjectRunError();
    }
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
          id: (
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
          ).id,
        };
    }
  }

  private assertAvailable(provider: Provider): void {
    const availability = WorkerPresence.of(
      this.statuses.latest(),
      Lease.ofSeconds(this.lease.seconds),
    )
      .providerAvailability(this.clock.now())
      .find((candidate) => candidate.id === provider);
    if (!availability || availability.reason) {
      throw new ProviderUnavailableError(
        provider,
        availability?.reason ?? PROVIDER_UNAVAILABLE_REASONS.switchedOff,
      );
    }
  }
}
