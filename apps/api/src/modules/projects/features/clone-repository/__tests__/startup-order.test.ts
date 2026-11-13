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
import { CloneRepositoryHandler } from '../handler.js';

// Issue #60 clarification 11: the Git adapter's start-up sweep (its `onModuleInit`) removes
// leftovers of any age, so no clone may reconcile or run before it has finished. The clone
// queue is registered in `onModuleInit` and the platform queue reconciles and starts its
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
}

@Module({
  providers: [
    { provide: REPOSITORY_GIT, useClass: SlowSweepGit },
    { provide: PROJECT_REPOSITORY, useClass: RecordingProjects },
    { provide: JobQueues, useClass: BootstrappingJobQueues },
    CloneRepositoryHandler,
  ],
})
class StartupModule {}

describe('clone start-up order', () => {
  it('reconciles and starts the clone worker only after the Git sweep has finished', async () => {
    const app = await NestFactory.createApplicationContext(StartupModule, { logger: false });
    try {
      await app.init();

      const sweepFinished = events.indexOf('git: sweep finished');
      expect(events).toContain('queue: registered repository-clone');
      expect(sweepFinished).toBeGreaterThanOrEqual(0);
      expect(events.indexOf('projects: interrupted connections failed')).toBeGreaterThan(
        sweepFinished,
      );
      expect(events.indexOf('queue: worker started')).toBeGreaterThan(
        events.indexOf('projects: interrupted connections failed'),
      );
    } finally {
      await app.close();
    }
  });
});
