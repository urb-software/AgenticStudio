import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../../platform/database/database.module.js';
import {
  startStudioApp,
  startStudioServices,
  type StudioServices,
} from '../../../../../__tests__/studio-test-app.js';
import { SECRET_STORE, type SecretStore } from '../../../../../platform/secrets/index.js';
import {
  PREVIEW_OPERATION_LOG,
  type PreviewOperationLog,
} from '../../../application/ports/preview-operation-log.js';
import { PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER } from '../../../application/ports/preview-environment-file-snapshots.js';
import { SweepPreviewEnvironmentFilesHandler } from '../../../application/features/sweep-preview-environment-files/handler.js';
import { PreviewLogLine } from '../../../domain/value-objects/preview-log-line.js';
import { PreviewLogRedaction } from '../../../domain/value-objects/preview-log-redaction.js';
import { RequestPreviewOperationHandler } from '../../../application/features/request-preview-operation/handler.js';
import { PreviewOperation } from '../../../domain/entities/preview-operation.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../../../domain/repositories/preview-operation-repository.js';
import { LostControllerRule } from '../../../domain/value-objects/lost-controller-rule.js';
import { PreviewOperationHandOutRule } from '../../../domain/value-objects/preview-operation-hand-out-rule.js';
import type { PreviewOperationQueueView } from '../../../domain/value-objects/preview-operation-queue-view.js';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const LEASE_SECONDS = 60;
const CONTROLLER = randomUUID();
const seconds = (count: number) => new Date(NOW.getTime() + count * 1000);

describe('the Preview operation store follows the rules of the domain (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const operations = () => app.get<PreviewOperationRepository>(PREVIEW_OPERATION_REPOSITORY);

  beforeAll(async () => {
    services = await startStudioServices();
    app = await startStudioApp(services.config);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
  });

  interface Spec {
    project: number;
    status: 'requested' | 'claimed' | 'succeeded' | 'failed';
    requestedAt: number;
    heartbeatAt?: number;
  }

  async function fixtures(projectCount: number, specs: Spec[]): Promise<Map<string, number>> {
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    const projectIds: string[] = [];
    for (let i = 0; i < projectCount; i += 1) {
      const name = `Shop ${randomUUID()}`;
      const [project] = await db().$queryRaw<{ id: string }[]>`
        INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
        RETURNING id`;
      projectIds.push(project!.id);
    }
    const indexes = new Map<string, number>();
    for (const [index, spec] of specs.entries()) {
      const claimed = spec.status === 'claimed';
      const final = spec.status === 'succeeded' || spec.status === 'failed';
      const row = await db().previewOperation.create({
        data: {
          projectId: projectIds[spec.project]!,
          kind: 'stop',
          status: spec.status,
          requestedAt: seconds(spec.requestedAt),
          ...(claimed || final ? { claimedBy: randomUUID(), claimedAt: seconds(-500) } : {}),
          ...(claimed ? { heartbeatAt: seconds(spec.heartbeatAt ?? -5) } : {}),
          ...(final ? { finishedAt: seconds(-100) } : {}),
          ...(spec.status === 'failed' ? { failureCode: 'build_failed', failureDetail: 'x' } : {}),
        },
      });
      indexes.set(row.id, index);
    }
    return indexes;
  }

  async function views(): Promise<PreviewOperationQueueView[]> {
    const rows = await db().previewOperation.findMany();
    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      status: row.status as PreviewOperationQueueView['status'],
      requestedAt: row.requestedAt,
      heartbeatAt: row.heartbeatAt,
    }));
  }

  it('hands out what the hand-out rule picks, one operation at a time, until the rule picks none', async () => {
    const indexes = await fixtures(4, [
      { project: 0, status: 'requested', requestedAt: -400 },
      { project: 0, status: 'requested', requestedAt: -390 },
      { project: 1, status: 'claimed', requestedAt: -480, heartbeatAt: -5 },
      { project: 1, status: 'requested', requestedAt: -450 },
      { project: 2, status: 'succeeded', requestedAt: -470 },
      { project: 2, status: 'requested', requestedAt: -300 },
      { project: 3, status: 'requested', requestedAt: -299 },
      { project: 3, status: 'failed', requestedAt: -500 },
    ]);
    const rule = PreviewOperationHandOutRule.at(NOW, LEASE_SECONDS);

    const handedOut: number[] = [];
    for (let guard = 0; guard < 20; guard += 1) {
      const expected = rule.next(await views());
      const claimed = await operations().claimNext(CONTROLLER, NOW);
      expect(claimed?.id).toBe(expected?.id);
      if (!claimed) break;
      handedOut.push(indexes.get(claimed.id)!);
    }

    expect(handedOut).toEqual([0, 5, 6]);
  });

  it('fails what the lost-controller rule selects and nothing else, and releases their snapshots', async () => {
    const indexes = await fixtures(4, [
      { project: 0, status: 'claimed', requestedAt: -400, heartbeatAt: -61 },
      { project: 1, status: 'claimed', requestedAt: -400, heartbeatAt: -60 },
      { project: 2, status: 'claimed', requestedAt: -400, heartbeatAt: -5 },
      { project: 3, status: 'requested', requestedAt: -400 },
    ]);
    const rule = LostControllerRule.at(NOW, LEASE_SECONDS);
    const before = await views();
    const expected = before.filter((operation) => rule.selects(operation)).map((o) => o.id);

    await operations().failLost(rule, NOW);

    const lost = (await db().previewOperation.findMany({ where: { status: 'failed' } })).map(
      (row) => row.id,
    );
    expect(lost.sort()).toEqual(expected.sort());
    expect(lost.map((id) => indexes.get(id))).toEqual([0]);
    const failed = await db().previewOperation.findUniqueOrThrow({ where: { id: lost[0]! } });
    expect(failed).toMatchObject({
      failureCode: 'controller_lost',
      finishedAt: NOW,
      heartbeatAt: null,
    });
  });

  it('returns the secret references a lost operation held', async () => {
    await fixtures(1, [{ project: 0, status: 'claimed', requestedAt: -400, heartbeatAt: -120 }]);
    const secretId = randomUUID();
    await db().previewOperation.updateMany({
      data: { environmentFilePath: '.env', environmentFileSecretId: secretId },
    });

    const released = await operations().failLost(LostControllerRule.at(NOW, LEASE_SECONDS), NOW);

    expect(released).toEqual([secretId]);
    expect(await operations().listEnvironmentFileSecrets()).toEqual([]);
  });

  it('appends log lines for exactly the holder that the entity accepts', async () => {
    const indexes = await fixtures(4, [
      { project: 0, status: 'claimed', requestedAt: -400, heartbeatAt: -5 },
      { project: 1, status: 'requested', requestedAt: -400 },
      { project: 2, status: 'succeeded', requestedAt: -400 },
      { project: 3, status: 'claimed', requestedAt: -400, heartbeatAt: -5 },
    ]);
    const log = app.get<PreviewOperationLog>(PREVIEW_OPERATION_LOG);
    const line = PreviewLogLine.load(
      { seq: 1, at: NOW, stream: 'build', text: 'x' },
      PreviewLogRedaction.of([]),
    );

    for (const id of indexes.keys()) {
      const operation = (await operations().find(id))!;
      for (const controllerId of [operation.claimedBy ?? CONTROLLER, randomUUID()]) {
        let held = true;
        try {
          operation.assertHeldBy(controllerId);
        } catch {
          held = false;
        }
        const appended = await log.append(id, controllerId, [line], 1000);
        expect(appended !== null, `${operation.status} for ${controllerId}`).toBe(held);
        if (held) await db().previewOperationLine.deleteMany({ where: { operationId: id } });
      }
    }
  });

  it('sweeps an old snapshot no operation references and keeps a referenced one', async () => {
    await fixtures(1, [{ project: 0, status: 'claimed', requestedAt: -400, heartbeatAt: -5 }]);
    const store = app.get<SecretStore>(SECRET_STORE);
    const owner = { owner: PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER };
    const orphan = await store.put('DB=orphan-value-0001', owner);
    const referenced = await store.put('DB=referenced-value-0002', owner);
    await db().previewOperation.updateMany({
      data: { environmentFilePath: '.env', environmentFileSecretId: referenced },
    });
    const sweep = new SweepPreviewEnvironmentFilesHandler(operations(), store, {
      leaseSeconds: LEASE_SECONDS,
      logMaxBytes: 1024,
      snapshotGraceMs: 0,
    });

    await sweep.execute();

    const left = await store.listOlderThan(PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER, 0);
    expect(left).toContain(referenced);
    expect(left).not.toContain(orphan);
    await store.delete(referenced);
  });

  describe('the migration', () => {
    async function project(): Promise<string> {
      const name = `Shop ${randomUUID()}`;
      const [row] = await db().$queryRaw<{ id: string }[]>`
        INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
        RETURNING id`;
      return row!.id;
    }

    const claimedRow = (projectId: string) =>
      db().previewOperation.create({
        data: {
          projectId,
          kind: 'stop',
          status: 'claimed',
          claimedBy: randomUUID(),
          claimedAt: NOW,
          heartbeatAt: NOW,
        },
      });

    it('allows one claimed operation per Project through a partial unique index', async () => {
      await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
      const first = await project();
      const second = await project();

      await claimedRow(first);
      await expect(claimedRow(first)).rejects.toThrow();
      await expect(claimedRow(second)).resolves.toBeDefined();
      // Only claimed rows count: any number of final or requested ones.
      for (const status of ['requested', 'requested'] as const) {
        await db().previewOperation.create({ data: { projectId: first, kind: 'stop', status } });
      }
    });

    it('sets the build columns exactly when the operation is a build', async () => {
      await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
      const projectId = await project();

      await expect(
        db().previewOperation.create({
          data: { projectId, kind: 'build', status: 'requested' },
        }),
      ).rejects.toThrow();
      await expect(
        db().previewOperation.create({
          data: { projectId, kind: 'stop', status: 'requested', commit: 'a'.repeat(40) },
        }),
      ).rejects.toThrow();
      await expect(
        db().previewOperation.create({
          data: {
            projectId,
            kind: 'build',
            status: 'requested',
            commit: 'a'.repeat(40),
            composeFile: 'compose.yaml',
            service: 'web',
            port: 3000,
            memoryMiB: 127,
            cpuPercent: 100,
            tasksMax: 512,
            buildMinutes: 20,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses an unknown kind, status or log stream, and removes operations with the Project', async () => {
      await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
      const projectId = await project();

      await expect(
        db().previewOperation.create({ data: { projectId, kind: 'start', status: 'requested' } }),
      ).rejects.toThrow();
      await expect(
        db().previewOperation.create({ data: { projectId, kind: 'stop', status: 'done' } }),
      ).rejects.toThrow();
      const operation = await db().previewOperation.create({
        data: { projectId, kind: 'stop', status: 'requested' },
      });
      await expect(
        db().previewOperationLine.create({
          data: { operationId: operation.id, seq: 1, at: NOW, stream: 'stdout', text: 'x' },
        }),
      ).rejects.toThrow();

      await db().$executeRaw`DELETE FROM projects WHERE id = ${projectId}::uuid`;
      expect(await db().previewOperation.count()).toBe(0);
    });
  });

  describe('requesting a build through the handler', () => {
    it('refuses an unknown Project and records nothing', async () => {
      await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
      const handler = app.get(RequestPreviewOperationHandler);

      await expect(handler.execute({ projectId: randomUUID(), kind: 'stop' })).rejects.toThrow(
        'No project has this id.',
      );
      expect(await db().previewOperation.count()).toBe(0);
    });

    it('stores a stop for a Project, as a requested operation', async () => {
      await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
      const name = `Shop ${randomUUID()}`;
      const [project] = await db().$queryRaw<{ id: string }[]>`
        INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
        RETURNING id`;

      const { operationId } = await app
        .get(RequestPreviewOperationHandler)
        .execute({ projectId: project!.id, kind: 'stop' });

      const stored = await operations().find(operationId);
      expect(stored).toBeInstanceOf(PreviewOperation);
      expect(stored).toMatchObject({ projectId: project!.id, kind: 'stop', status: 'requested' });
    });
  });
});
