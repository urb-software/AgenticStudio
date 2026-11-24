import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewOperation } from '../../../../domain/entities/preview-operation.js';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { PreviewCommit } from '../../../../domain/value-objects/preview-commit.js';
import { PreviewComposeFile } from '../../../../domain/value-objects/preview-compose-file.js';
import { PreviewLimits } from '../../../../domain/value-objects/preview-limits.js';
import { PreviewOperationFailure } from '../../../../domain/value-objects/preview-operation-failure.js';
import { PreviewPort } from '../../../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../../../domain/value-objects/preview-service.js';
import { FakePreviewSources } from '../../../ports/__tests__/fake-preview-sources.js';
import { InMemorySecretStore } from '../../../ports/__tests__/in-memory-secret-store.js';
import { KIT_NOW, OPERATION_SETTINGS, previewKit } from '../../../__tests__/preview-test-kit.js';
import { PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER } from '../../../ports/preview-environment-file-snapshots.js';
import { SweepPreviewOperationsHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OTHER_PROJECT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const CONTROLLER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const seconds = (count: number) => new Date(KIT_NOW.getTime() + count * 1000);
const minutes = (count: number) => seconds(count * 60);

describe('SweepPreviewOperationsHandler', () => {
  let operations: InMemoryPreviewOperationRepository;
  let secrets: InMemorySecretStore;
  let kit: ReturnType<typeof previewKit>;
  let handler: SweepPreviewOperationsHandler;

  beforeEach(() => {
    operations = new InMemoryPreviewOperationRepository();
    secrets = new InMemorySecretStore();
    kit = previewKit(operations, new FakePreviewSources());
    handler = new SweepPreviewOperationsHandler(
      operations,
      secrets,
      OPERATION_SETTINGS,
      kit.clock,
      kit.presence,
    );
  });

  async function request(id: string, projectId: string, requestedAt: Date, buildMinutes = 20) {
    await operations.add(
      PreviewOperation.requestBuild({
        id,
        projectId,
        commit: PreviewCommit.of('a'.repeat(40)),
        composeFile: PreviewComposeFile.of('compose.yaml'),
        service: PreviewService.of('web'),
        port: PreviewPort.of(3000),
        limits: PreviewLimits.of({ memoryMiB: 1024, cpuPercent: 100, tasksMax: 512, buildMinutes }),
        now: requestedAt,
      }),
    );
  }

  async function claim(id: string, claimedAt: Date, heartbeatAt = claimedAt) {
    await operations.change(id, (op) => {
      op.claim(CONTROLLER, claimedAt);
      op.reportProgress(CONTROLLER, heartbeatAt);
    });
  }

  const failureOf = async (id: string) => (await operations.find(id))?.failure?.code;

  it('fails a claimed operation whose controller stopped reporting, as controller_lost', async () => {
    await request('a', PROJECT, minutes(-10));
    await claim('a', minutes(-10), seconds(-61));

    await handler.execute();

    expect(await failureOf('a')).toBe('controller_lost');
  });

  it('leaves a claimed operation that reported within the lease', async () => {
    await request('a', PROJECT, minutes(-10));
    await claim('a', minutes(-10), seconds(-30));

    await handler.execute();

    expect((await operations.find('a'))?.status).toBe('claimed');
  });

  it('fails an overdue build though its heartbeat is fresh, as report_overdue', async () => {
    await request('a', PROJECT, minutes(-40), 20);
    await claim('a', minutes(-26), seconds(-5));

    await handler.execute();

    expect(await failureOf('a')).toBe('report_overdue');
  });

  it('leaves a build within its time limit plus the margin', async () => {
    await request('a', PROJECT, minutes(-40), 20);
    await claim('a', minutes(-24), seconds(-5));

    await handler.execute();

    expect((await operations.find('a'))?.status).toBe('claimed');
  });

  it('deletes the Environment file snapshot of a lost or overdue operation', async () => {
    await request('lost', PROJECT, minutes(-40));
    await claim('lost', minutes(-30), seconds(-120));
    await request('slow', OTHER_PROJECT, minutes(-40));
    await claim('slow', minutes(-30), seconds(-5));
    const owner = { owner: PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER };
    const lostSecret = await secrets.put('DB=lost-value-0001', owner);
    const slowSecret = await secrets.put('DB=slow-value-0002', owner);
    await operations.change('lost', (op) =>
      op.recordEnvironmentFile(CONTROLLER, { path: '.env', secretId: lostSecret }),
    );
    await operations.change('slow', (op) =>
      op.recordEnvironmentFile(CONTROLLER, { path: '.env', secretId: slowSecret }),
    );

    const result = await handler.execute();

    expect(result.releasedSnapshots).toBe(2);
    expect(secrets.values.size).toBe(0);
  });

  describe('state checks (step 4)', () => {
    const stateChecks = () =>
      [...operations.operations.values()].filter((operation) => operation.kind === 'state');

    it.each(['controller_lost', 'report_overdue'] as const)(
      'requests one state check for a Project whose newest operation is a build lost as %s',
      async (code) => {
        await request('a', PROJECT, minutes(-40), 20);
        if (code === 'controller_lost') await claim('a', minutes(-30), seconds(-120));
        else await claim('a', minutes(-26), seconds(-5));

        const result = await handler.execute();

        expect(await failureOf('a')).toBe(code);
        expect(result.stateChecks).toBe(1);
        expect(stateChecks()).toHaveLength(1);
        expect(stateChecks()[0]).toMatchObject({
          projectId: PROJECT,
          status: 'requested',
          requestedAt: KIT_NOW,
        });
      },
    );

    it('is idempotent: the state check is the newest operation, so the next sweep adds none', async () => {
      await request('a', PROJECT, minutes(-40));
      await claim('a', minutes(-30), seconds(-120));

      await handler.execute();
      const again = await handler.execute();

      expect(again.stateChecks).toBe(0);
      expect(stateChecks()).toHaveLength(1);
    });

    it('requests none for a build that failed another way, or was never claimed', async () => {
      await request('a', PROJECT, minutes(-40));
      await claim('a', minutes(-30), seconds(-5));
      await operations.change('a', (op) => {
        op.fail(CONTROLLER, PreviewOperationFailure.of('build_failed', 'x'), seconds(-1));
      });
      kit.presence.seen = seconds(-10);
      await request('b', OTHER_PROJECT, minutes(-60));
      await operations.change('b', (op) => {
        op.failUnclaimed(PreviewOperationFailure.of('not_claimed', 'x'), seconds(-1));
      });

      const result = await handler.execute();

      expect(result.stateChecks).toBe(0);
      expect(stateChecks()).toHaveLength(0);
    });

    it('requests none when a later operation exists', async () => {
      await request('a', PROJECT, minutes(-40));
      await claim('a', minutes(-30), seconds(-120));
      await operations.change('a', (op) => {
        op.loseController(PreviewOperationFailure.of('controller_lost', 'x'), minutes(-20));
      });
      await request('b', PROJECT, minutes(-5));

      expect((await handler.execute()).stateChecks).toBe(0);
    });
  });

  describe('unclaimed operations', () => {
    it('fails a requested operation older than the limit once no controller is known to exist', async () => {
      await request('a', PROJECT, minutes(-6));

      const result = await handler.execute();

      expect(result.unclaimed).toBe(1);
      expect(await failureOf('a')).toBe('not_claimed');
    });

    it('leaves a younger requested operation', async () => {
      await request('a', PROJECT, minutes(-4));

      await handler.execute();

      expect((await operations.find('a'))?.status).toBe('requested');
    });

    it('leaves a requested operation while a controller is connected', async () => {
      await request('a', PROJECT, minutes(-60));
      kit.presence.seen = seconds(-10);

      await handler.execute();

      expect((await operations.find('a'))?.status).toBe('requested');
    });

    it('leaves it in the start-up grace, when nothing is known yet', async () => {
      const fresh = previewKit(operations, new FakePreviewSources(), KIT_NOW, 30_000);
      const justStarted = new SweepPreviewOperationsHandler(
        operations,
        secrets,
        OPERATION_SETTINGS,
        fresh.clock,
        fresh.presence,
      );
      await request('a', PROJECT, minutes(-60));

      await justStarted.execute();

      expect((await operations.find('a'))?.status).toBe('requested');
    });
  });
});
