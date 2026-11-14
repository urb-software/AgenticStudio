import { Injectable, Module, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import {
  type JobPayload,
  type JobQueue,
  JobQueues,
  type QueueDefinition,
} from '../../../../../platform/queue/job-queue.js';
import { PROJECT_REPOSITORY } from '../../../domain/repositories/project-repository.js';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { REPOSITORY_GIT } from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { CleanUpRepositoryHandler } from '../../clean-up-repository/handler.js';
import { CloneRepositoryHandler } from '../../clone-repository/handler.js';
import { SECRET_STORE } from '../../../../../platform/secrets/index.js';
import { DeployKeyHandler, SSH_TRUST_SETTINGS } from '../../deploy-key/handler.js';
import { InMemorySecretStore } from '../../deploy-key/__tests__/in-memory-secret-store.js';
import { RefreshCloneHandler } from '../../refresh-clone/handler.js';
import {
  DEPLOY_KEY_SWEEP_SETTINGS,
  SweepOrphanedDeployKeysHandler,
} from '../../sweep-orphaned-deploy-keys/handler.js';
import { RepositoryJobsHandler } from '../handler.js';

// Issue #60 clarification 11: the Git adapter's start-up sweep (its `onModuleInit`) removes
// leftovers of any age, so no clone or fetch may reconcile or run before it has finished. The
// repository queue is registered in `onModuleInit` and the platform queue reconciles and starts its
// workers in `onApplicationBootstrap` (BullMqJobQueues); Nest runs every `onModuleInit`
// before any `onApplicationBootstrap`. This pins that order with a deliberately slow sweep.

const events: string[] = [];

class SlowSweepGit extends FakeRepositoryGit implements OnModuleInit {
  async onModuleInit(): Promise<void> {
    events.push('git: sweep started');
    await new Promise((resolve) => setTimeout(resolve, 50));
    events.push('git: sweep finished');
  }
}

/** Behaves like BullMqJobQueues at start-up: reconcile, then start the worker, at bootstrap. */
@Injectable()
class BootstrappingJobQueues extends JobQueues implements OnApplicationBootstrap {
  private definition: QueueDefinition<JobPayload> | undefined;

  register<P extends JobPayload>(definition: QueueDefinition<P>): JobQueue<P> {
    events.push(`queue: registered ${definition.name}`);
    this.definition = definition as unknown as QueueDefinition<JobPayload>;
    return { enqueue: () => Promise.resolve(), cancel: () => Promise.resolve(false) };
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.definition?.reconcile([]);
    events.push('queue: reconciled');
    events.push('queue: worker started');
  }
}

class RecordingProjects extends InMemoryProjectRepository {
  override failAllConnecting(...args: Parameters<InMemoryProjectRepository['failAllConnecting']>) {
    events.push('projects: interrupted connections failed');
    return super.failAllConnecting(...args);
  }

  override failAllFetching(...args: Parameters<InMemoryProjectRepository['failAllFetching']>) {
    events.push('projects: interrupted fetches failed');
    return super.failAllFetching(...args);
  }

  override listDisconnecting() {
    events.push('projects: pending disconnects resumed');
    return super.listDisconnecting();
  }
}

class RecordingSecrets extends InMemorySecretStore {
  override listOlderThan(...args: Parameters<InMemorySecretStore['listOlderThan']>) {
    events.push('secrets: orphaned Deploy keys swept');
    return super.listOlderThan(...args);
  }
}

@Module({
  providers: [
    { provide: REPOSITORY_GIT, useClass: SlowSweepGit },
    { provide: PROJECT_REPOSITORY, useClass: RecordingProjects },
    { provide: JobQueues, useClass: BootstrappingJobQueues },
    { provide: SECRET_STORE, useClass: RecordingSecrets },
    { provide: SSH_TRUST_SETTINGS, useValue: { knownHosts: [] } },
    { provide: DEPLOY_KEY_SWEEP_SETTINGS, useValue: { gracePeriodMs: 0 } },
    DeployKeyHandler,
    SweepOrphanedDeployKeysHandler,
    CloneRepositoryHandler,
    RefreshCloneHandler,
    CleanUpRepositoryHandler,
    RepositoryJobsHandler,
  ],
})
class StartupModule {}

describe('repository job start-up order', () => {
  it('reconciles clones and fetches, resumes disconnects, sweeps orphaned Deploy keys and starts the worker only after the Git sweep has finished', async () => {
    const app = await NestFactory.createApplicationContext(StartupModule, { logger: false });
    try {
      await app.init();

      const sweepFinished = events.indexOf('git: sweep finished');
      expect(events).toContain('queue: registered repository-git');
      expect(sweepFinished).toBeGreaterThanOrEqual(0);
      expect(events.indexOf('projects: interrupted connections failed')).toBeGreaterThan(
        sweepFinished,
      );
      expect(events.indexOf('projects: interrupted fetches failed')).toBeGreaterThan(sweepFinished);
      expect(events.indexOf('projects: pending disconnects resumed')).toBeGreaterThan(
        sweepFinished,
      );
      // Issue #76: after reconciliation (pending disconnects delete their own keys first).
      expect(events.indexOf('secrets: orphaned Deploy keys swept')).toBeGreaterThan(
        events.indexOf('projects: pending disconnects resumed'),
      );
      for (const reconciled of [
        'projects: interrupted connections failed',
        'projects: interrupted fetches failed',
        'projects: pending disconnects resumed',
        'secrets: orphaned Deploy keys swept',
      ]) {
        expect(events.indexOf('queue: worker started')).toBeGreaterThan(events.indexOf(reconciled));
      }
    } finally {
      await app.close();
    }
  });
});
