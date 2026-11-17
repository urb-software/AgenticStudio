import { startRedis, type TestService } from '@agentic-studio/testing';
import { type INestApplicationContext, Module, type OnModuleInit } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../../../../../../__tests__/test-config.js';
import { ConfigModule } from '../../../../../../platform/config/config.module.js';
import {
  type QueueWorkerTuning,
  QueueModule,
} from '../../../../../../platform/queue/queue.module.js';
import { SECRET_STORE } from '../../../../../../platform/secrets/index.js';
import { PROJECT_REPOSITORY } from '../../../../domain/repositories/project-repository.js';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { REPOSITORY_CONNECTION_REPOSITORY } from '../../../../domain/repositories/repository-connection-repository.js';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import { REPOSITORY_GIT } from '../../../../application/ports/repository-git.js';
import { FakeRepositoryGit } from '../../../../application/ports/__tests__/fake-repository-git.js';
import { DisconnectRepositoryHandler } from '../../../../application/features/disconnect-repository/handler.js';
import { CloneRepositoryHandler } from '../../../../application/features/clone-repository/handler.js';
import {
  DEPLOY_KEY_SWEEP_SETTINGS,
  DEPLOY_KEYS,
} from '../../../../application/ports/deploy-keys.js';
import { InMemorySecretStore } from '../../../../application/ports/__tests__/in-memory-secret-store.js';
import { SecretStoreDeployKeys, SSH_TRUST_SETTINGS } from '../../secret-store-deploy-keys.js';
import { FetchCloneHandler } from '../../../../application/features/fetch-clone/handler.js';
import { SweepOrphanedDeployKeysHandler } from '../../../../application/features/sweep-orphaned-deploy-keys/handler.js';
import { GetRepositoryOperationHandler } from '../../../../application/features/get-repository-operation/handler.js';
import { REPOSITORY_JOBS } from '../../../../application/ports/repository-jobs.js';
import { RepositoryJobProcessor } from '../../../../entry-points/jobs/repository-job-processor.js';
import { RepositoryStartupRecovery } from '../../../../entry-points/startup/repository-startup-recovery.js';
import { QueueRepositoryJobs } from '../../queue-repository-jobs.js';
import { SweepOrphanedEnvironmentFilesHandler } from '../../../../application/features/sweep-orphaned-environment-files/handler.js';
import { ENVIRONMENT_FILE_REPOSITORY } from '../../../../domain/repositories/environment-file-repository.js';
import { InMemoryEnvironmentFileRepository } from '../../../../domain/repositories/__tests__/in-memory-environment-file-repository.js';
import { ENVIRONMENT_FILE_CONTENTS } from '../../../../application/ports/environment-file-contents.js';
import { InMemoryEnvironmentFileContents } from '../../../../application/ports/__tests__/in-memory-environment-file-contents.js';

// Issue #60 clarification 11: the Git adapter's start-up sweep (its `onModuleInit`) removes
// leftovers of any age, so no clone or fetch may reconcile or run before it has finished. The
// repository queue is registered in `onModuleInit`, and the platform queue reconciles and
// starts its workers in `onApplicationBootstrap`; Nest runs every `onModuleInit` before any
// `onApplicationBootstrap`. This pins that order with a deliberately slow sweep, on the real
// platform queue (BullMQ on Redis via Testcontainers, PR #71 review S-SP6 (a), #72): a job
// already waiting in Redis at start-up runs only after the sweep and the reconciliation.
// It lives next to the Git adapter, whose sweep it orders, because only infrastructure/ may
// reach a concrete client (BullMQ, Redis) from inside the module (`architecture:api`).

const PROJECT = '7f3e2a1b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const events: string[] = [];

class SlowSweepGit extends FakeRepositoryGit implements OnModuleInit {
  async onModuleInit(): Promise<void> {
    events.push('git: sweep started');
    await new Promise((resolve) => setTimeout(resolve, 50));
    events.push('git: sweep finished');
  }
}

class RecordingConnections extends InMemoryRepositoryConnectionRepository {
  override listIdsInState(
    ...args: Parameters<InMemoryRepositoryConnectionRepository['listIdsInState']>
  ) {
    const events_: Record<string, string> = {
      connecting: 'projects: interrupted connections failed',
      fetching: 'projects: interrupted fetches failed',
      disconnecting: 'projects: pending disconnects resumed',
    };
    const event = events_[args[0]];
    if (event) events.push(event);
    return super.listIdsInState(...args);
  }

  /**
   * The first thing a job does: read the Repository, whose state says what to run. Nothing in
   * the start-up path reads a Repository here (no Repository is connecting, fetching or
   * disconnecting), so this marks the job; the test also checks it happens at all.
   */
  override find(...args: Parameters<InMemoryRepositoryConnectionRepository['find']>) {
    events.push('queue: job ran');
    return super.find(...args);
  }
}

class RecordingSecrets extends InMemorySecretStore {
  override listOlderThan(...args: Parameters<InMemorySecretStore['listOlderThan']>) {
    events.push('secrets: orphaned Deploy keys swept');
    return super.listOlderThan(...args);
  }
}

/** The repository job wiring of `ProjectsModule`, on the real platform queue. */
function startupContext(
  redisUrl: string,
  tuning?: QueueWorkerTuning,
): Promise<INestApplicationContext> {
  @Module({
    imports: [ConfigModule.forRoot(testConfig({ redisUrl })), QueueModule.forRoot(tuning)],
    providers: [
      { provide: REPOSITORY_GIT, useClass: SlowSweepGit },
      { provide: PROJECT_REPOSITORY, useClass: InMemoryProjectRepository },
      { provide: REPOSITORY_CONNECTION_REPOSITORY, useClass: RecordingConnections },
      { provide: SECRET_STORE, useClass: RecordingSecrets },
      { provide: SSH_TRUST_SETTINGS, useValue: { knownHosts: [] } },
      { provide: DEPLOY_KEY_SWEEP_SETTINGS, useValue: { gracePeriodMs: 0 } },
      { provide: DEPLOY_KEYS, useClass: SecretStoreDeployKeys },
      SweepOrphanedDeployKeysHandler,
      // Issue #104: the Environment file orphan sweep runs in the same reconciliation.
      { provide: ENVIRONMENT_FILE_REPOSITORY, useClass: InMemoryEnvironmentFileRepository },
      { provide: ENVIRONMENT_FILE_CONTENTS, useClass: InMemoryEnvironmentFileContents },
      SweepOrphanedEnvironmentFilesHandler,
      CloneRepositoryHandler,
      FetchCloneHandler,
      DisconnectRepositoryHandler,
      GetRepositoryOperationHandler,
      RepositoryStartupRecovery,
      RepositoryJobProcessor,
      QueueRepositoryJobs,
      { provide: REPOSITORY_JOBS, useExisting: QueueRepositoryJobs },
      {
        provide: 'REPOSITORY_JOB_ROUTING',
        useFactory: (jobs: QueueRepositoryJobs, processor: RepositoryJobProcessor) =>
          jobs.deliverTo(processor),
        inject: [QueueRepositoryJobs, RepositoryJobProcessor],
      },
    ],
  })
  class StartupModule {}
  return NestFactory.createApplicationContext(StartupModule, { logger: false });
}

/** Polls until `check` passes or the deadline expires (no fixed sleeps). */
async function eventually(check: () => void, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

describe('repository job start-up order (Redis via Testcontainers)', () => {
  let redis: TestService;

  beforeAll(async () => {
    redis = await startRedis();
  });

  afterAll(async () => {
    await redis?.stop();
  });

  it('reconciles clones and fetches, resumes disconnects, sweeps orphaned Deploy keys and runs a waiting job only after the Git sweep has finished', async () => {
    // A job left waiting in Redis by an earlier run, enqueued through the real queue by an
    // instance that starts no worker.
    const earlier = await startupContext(redis.url, { startWorkers: false });
    try {
      await earlier.init();
      await earlier.get(QueueRepositoryJobs).start(PROJECT, 'clone');
    } finally {
      await earlier.close();
    }
    events.length = 0;

    const app = await startupContext(redis.url);
    try {
      await app.init();
      await eventually(() => expect(events).toContain('queue: job ran'));

      const sweepFinished = events.indexOf('git: sweep finished');
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
        expect(events.indexOf('queue: job ran')).toBeGreaterThan(events.indexOf(reconciled));
      }
    } finally {
      await app.close();
    }
  });
});
