import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startStudioApp,
  startStudioServices,
  type StudioServices,
} from '../../../../../__tests__/studio-test-app.js';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../../platform/database/database.module.js';
import { SECRET_STORE, type SecretStore } from '../../../../../platform/secrets/index.js';
import { SweepPreviewOperationsHandler } from '../../../application/features/sweep-preview-operations/handler.js';
import { FakeControllerPresence } from '../../../application/ports/__tests__/fake-controller-presence.js';
import { PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER } from '../../../application/ports/preview-environment-file-snapshots.js';
import {
  PREVIEW_OPERATION_SETTINGS,
  type PreviewOperationSettings,
} from '../../../application/ports/preview-operation-settings.js';
import { PreviewOperation } from '../../../domain/entities/preview-operation.js';
import { PreviewBuildRunningError } from '../../../domain/errors/preview-settings-errors.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../../../domain/repositories/preview-operation-repository.js';
import { OverdueBuildRule } from '../../../domain/value-objects/overdue-build-rule.js';
import { PreviewCommit } from '../../../domain/value-objects/preview-commit.js';
import { PreviewComposeFile } from '../../../domain/value-objects/preview-compose-file.js';
import { PreviewLimits } from '../../../domain/value-objects/preview-limits.js';
import { PreviewPort } from '../../../domain/value-objects/preview-port.js';
import { PreviewRunningRule } from '../../../domain/value-objects/preview-running-rule.js';
import { PreviewService } from '../../../domain/value-objects/preview-service.js';
import { UnclaimedOperationRule } from '../../../domain/value-objects/unclaimed-operation-rule.js';

// The Preview build statements of the store against the rules of the domain, and the migration's
// index and CHECK (PostgreSQL + Redis via Testcontainers).

const NOW = new Date('2026-11-24T12:00:00.000Z');
const seconds = (count: number) => new Date(NOW.getTime() + count * 1000);
const minutes = (count: number) => seconds(count * 60);

type Status = 'requested' | 'claimed' | 'succeeded' | 'failed';
type Kind = 'build' | 'stop' | 'remove_data' | 'state';

interface Spec {
  project: number;
  kind?: Kind;
  status: Status;
  requestedAt: number;
  /** Minutes before NOW the operation was claimed. */
  claimedAt?: number;
  /** Minutes before NOW the operation finished. */
  finishedAt?: number;
  buildMinutes?: number;
  previewRemoved?: boolean;
}

describe('the Preview build store follows the rules of the domain (PostgreSQL + Redis via Testcontainers)', () => {
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

  async function projects(count: number): Promise<string[]> {
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const name = `Shop ${randomUUID()}`;
      const [project] = await db().$queryRaw<{ id: string }[]>`
        INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
        RETURNING id`;
      ids.push(project!.id);
    }
    return ids;
  }

  async function insert(projectIds: string[], spec: Spec): Promise<string> {
    const kind = spec.kind ?? 'build';
    const claimed = spec.status === 'claimed';
    const final = spec.status === 'succeeded' || spec.status === 'failed';
    const row = await db().previewOperation.create({
      data: {
        projectId: projectIds[spec.project]!,
        kind,
        status: spec.status,
        requestedAt: minutes(spec.requestedAt),
        ...(kind === 'build'
          ? {
              commit: 'a'.repeat(40),
              composeFile: 'compose.yaml',
              service: 'web',
              port: 3000,
              memoryMiB: 1024,
              cpuPercent: 100,
              tasksMax: 512,
              buildMinutes: spec.buildMinutes ?? 20,
            }
          : {}),
        ...(claimed || final
          ? { claimedBy: randomUUID(), claimedAt: minutes(spec.claimedAt ?? -500) }
          : {}),
        ...(claimed ? { heartbeatAt: seconds(-5) } : {}),
        ...(final ? { finishedAt: minutes(spec.finishedAt ?? -100) } : {}),
        ...(spec.status === 'failed'
          ? {
              failureCode: 'build_failed',
              failureDetail: 'x',
              previewRemoved: !!spec.previewRemoved,
            }
          : {}),
      },
    });
    return row.id;
  }

  const rows = () => db().previewOperation.findMany({ orderBy: { id: 'asc' } });

  describe('the migration', () => {
    it('allows one requested or claimed build per Project, and any number of other operations', async () => {
      const ids = await projects(2);
      await insert(ids, { project: 0, status: 'requested', requestedAt: -10 });

      await expect(
        insert(ids, { project: 0, status: 'requested', requestedAt: -9 }),
      ).rejects.toThrow();
      await expect(
        insert(ids, { project: 0, status: 'claimed', requestedAt: -9, claimedAt: -8 }),
      ).rejects.toThrow();
      await insert(ids, { project: 0, kind: 'stop', status: 'requested', requestedAt: -8 });
      await insert(ids, { project: 0, kind: 'stop', status: 'requested', requestedAt: -7 });
      await insert(ids, { project: 1, status: 'requested', requestedAt: -10 });
      await insert(ids, { project: 0, status: 'succeeded', requestedAt: -20 });
      await insert(ids, { project: 0, status: 'failed', requestedAt: -19 });
    });

    it('lets a new build in once the active one is final', async () => {
      const ids = await projects(1);
      const first = await insert(ids, { project: 0, status: 'requested', requestedAt: -10 });
      await db().$executeRaw`
        UPDATE preview_operations SET status = 'failed', failure_code = 'not_claimed',
          failure_detail = 'x', finished_at = now() WHERE id = ${first}::uuid`;

      await expect(
        insert(ids, { project: 0, status: 'requested', requestedAt: -9 }),
      ).resolves.toBeTruthy();
    });

    it('keeps preview_removed false unless the operation is a failed build', async () => {
      const ids = await projects(1);
      const bad = async (spec: Spec) => {
        const id = await insert(ids, { ...spec, previewRemoved: false });
        await db().$executeRaw`
          UPDATE preview_operations SET preview_removed = true WHERE id = ${id}::uuid`;
      };

      await expect(
        bad({ project: 0, kind: 'stop', status: 'failed', requestedAt: -5 }),
      ).rejects.toThrow();
      await expect(bad({ project: 0, status: 'succeeded', requestedAt: -6 })).rejects.toThrow();
      const failedBuild = await insert(ids, {
        project: 0,
        status: 'failed',
        requestedAt: -7,
        previewRemoved: true,
      });
      expect(
        (await db().previewOperation.findUniqueOrThrow({ where: { id: failedBuild } }))
          .previewRemoved,
      ).toBe(true);
    });

    it('has the lookup index on project, kind and finish time', async () => {
      const found = await db().$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'preview_operations'
          AND indexname IN ('preview_operations_project_kind_finished_at_idx',
                            'preview_operations_one_active_build_per_project')`;

      expect(found.map((row) => row.indexname).sort()).toEqual([
        'preview_operations_one_active_build_per_project',
        'preview_operations_project_kind_finished_at_idx',
      ]);
    });

    it('maps the violation of the index to PreviewBuildRunningError when a build is added', async () => {
      const ids = await projects(1);
      const build = (id: string) =>
        PreviewOperation.requestBuild({
          id,
          projectId: ids[0]!,
          commit: PreviewCommit.of('b'.repeat(40)),
          composeFile: PreviewComposeFile.of('compose.yaml'),
          service: PreviewService.of('web'),
          port: PreviewPort.of(3000),
          limits: PreviewLimits.of({
            memoryMiB: 1024,
            cpuPercent: 100,
            tasksMax: 512,
            buildMinutes: 20,
          }),
          now: NOW,
        });
      await operations().add(build(randomUUID()));

      await expect(operations().add(build(randomUUID()))).rejects.toBeInstanceOf(
        PreviewBuildRunningError,
      );
    });
  });

  describe('findPreviewFacts and PreviewRunningRule', () => {
    it('finds the newest finished operation the rule counts, and the newest build', async () => {
      const ids = await projects(3);
      await insert(ids, { project: 0, status: 'succeeded', requestedAt: -90, finishedAt: -80 });
      await insert(ids, {
        project: 0,
        kind: 'stop',
        status: 'succeeded',
        requestedAt: -70,
        finishedAt: -60,
      });
      await insert(ids, {
        project: 0,
        kind: 'state',
        status: 'succeeded',
        requestedAt: -50,
        finishedAt: -10,
      });
      await insert(ids, { project: 0, status: 'failed', requestedAt: -45, finishedAt: -40 });
      await insert(ids, {
        project: 0,
        status: 'failed',
        requestedAt: -35,
        finishedAt: -30,
        previewRemoved: true,
      });
      await insert(ids, { project: 1, status: 'succeeded', requestedAt: -90, finishedAt: -80 });
      await insert(ids, { project: 1, status: 'requested', requestedAt: -5 });
      await insert(ids, { project: 2, kind: 'stop', status: 'failed', requestedAt: -5 });

      const all = await rows();
      for (const [index, projectId] of ids.entries()) {
        const own = all.filter((row) => row.projectId === projectId);
        const byFinish = own
          .filter((row) =>
            PreviewRunningRule.create().changesRunning({
              kind: row.kind,
              status: row.status,
              previewRemoved: row.previewRemoved,
            }),
          )
          .sort(
            (a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime() || (a.id < b.id ? 1 : -1),
          );
        const builds = own
          .filter((row) => row.kind === 'build')
          .sort(
            (a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || (a.id < b.id ? 1 : -1),
          );

        const facts = await operations().findPreviewFacts(projectId);

        expect(facts.runningChange?.id, `project ${index}`).toBe(byFinish[0]?.id);
        expect(facts.latestBuild?.id, `project ${index}`).toBe(builds[0]?.id);
      }
    });

    it('breaks a tie of finish time by id, newest id first', async () => {
      const ids = await projects(1);
      const first = await insert(ids, {
        project: 0,
        status: 'succeeded',
        requestedAt: -90,
        finishedAt: -80,
      });
      const second = await insert(ids, {
        project: 0,
        kind: 'stop',
        status: 'succeeded',
        requestedAt: -89,
        finishedAt: -80,
      });

      const facts = await operations().findPreviewFacts(ids[0]!);

      expect(facts.runningChange?.id).toBe([first, second].sort().at(-1));
    });

    it('answers nothing for a Project with no operation', async () => {
      const ids = await projects(1);

      expect(await operations().findPreviewFacts(ids[0]!)).toEqual({
        latestBuild: null,
        runningChange: null,
      });
    });
  });

  describe('failOverdue and OverdueBuildRule', () => {
    it('fails what the rule selects and nothing else, with report_overdue, and releases the snapshot', async () => {
      const ids = await projects(6);
      await insert(ids, { project: 0, status: 'claimed', requestedAt: -60, claimedAt: -26 });
      await insert(ids, { project: 1, status: 'claimed', requestedAt: -60, claimedAt: -25 });
      await insert(ids, { project: 2, status: 'claimed', requestedAt: -60, claimedAt: -24 });
      await insert(ids, {
        project: 3,
        status: 'claimed',
        requestedAt: -60,
        claimedAt: -7,
        buildMinutes: 1,
      });
      await insert(ids, {
        project: 4,
        kind: 'stop',
        status: 'claimed',
        requestedAt: -60,
        claimedAt: -600,
      });
      await insert(ids, { project: 5, status: 'requested', requestedAt: -600 });
      const secretId = randomUUID();
      await db().previewOperation.updateMany({
        where: { projectId: ids[0]! },
        data: { environmentFilePath: '.env', environmentFileSecretId: secretId },
      });
      const rule = OverdueBuildRule.at(NOW);
      const expected = (await rows())
        .filter((row) =>
          rule.selects({
            status: row.status,
            kind: row.kind,
            claimedAt: row.claimedAt,
            buildMinutes: row.buildMinutes,
          }),
        )
        .map((row) => row.id)
        .sort();

      const released = await operations().failOverdue(rule, NOW);

      const failed = await db().previewOperation.findMany({ where: { status: 'failed' } });
      expect(failed.map((row) => row.id).sort()).toEqual(expected);
      expect(expected).toHaveLength(2);
      expect(failed[0]).toMatchObject({
        failureCode: 'report_overdue',
        finishedAt: NOW,
        heartbeatAt: null,
        environmentFileSecretId: null,
      });
      expect(released).toEqual([secretId]);
    });
  });

  describe('failUnclaimed and UnclaimedOperationRule', () => {
    it('fails what the rule selects and nothing else, with not_claimed', async () => {
      const ids = await projects(5);
      await insert(ids, { project: 0, status: 'requested', requestedAt: -6 });
      await insert(ids, { project: 1, status: 'requested', requestedAt: -5 });
      await insert(ids, { project: 2, status: 'requested', requestedAt: -1 });
      await insert(ids, { project: 3, kind: 'stop', status: 'requested', requestedAt: -60 });
      await insert(ids, { project: 4, status: 'claimed', requestedAt: -60 });
      const rule = UnclaimedOperationRule.at(NOW, 5);
      const expected = (await rows())
        .filter((row) => rule.selects({ status: row.status, requestedAt: row.requestedAt }))
        .map((row) => row.id)
        .sort();

      const failedCount = await operations().failUnclaimed(rule, NOW);

      const failed = await db().previewOperation.findMany({ where: { status: 'failed' } });
      expect(failed.map((row) => row.id).sort()).toEqual(expected);
      expect(failedCount).toBe(2);
      expect(failed[0]).toMatchObject({
        failureCode: 'not_claimed',
        finishedAt: NOW,
        claimedBy: null,
      });
    });
  });

  describe('the sweep with a controlled clock', () => {
    function sweep(options: { lastSeen: Date | null; startedAgoMinutes: number; now?: Date }) {
      const now = options.now ?? NOW;
      const presence = new FakeControllerPresence(minutes(-options.startedAgoMinutes));
      presence.seen = options.lastSeen;
      const settings = app.get<PreviewOperationSettings>(PREVIEW_OPERATION_SETTINGS);
      return new SweepPreviewOperationsHandler(
        operations(),
        app.get<SecretStore>(SECRET_STORE),
        { ...settings, leaseSeconds: 60, unclaimedMinutes: 5 },
        { now: () => now },
        presence,
      );
    }

    const failureOf = async (id: string) =>
      (await db().previewOperation.findUniqueOrThrow({ where: { id } })).failureCode;

    it('leaves a build controller_lost with no claim call, once the lease ran out', async () => {
      const ids = await projects(1);
      const id = await insert(ids, {
        project: 0,
        status: 'claimed',
        requestedAt: -10,
        claimedAt: -9,
      });
      await db().$executeRaw`
        UPDATE preview_operations SET heartbeat_at = ${seconds(-61)}::timestamptz WHERE id = ${id}::uuid`;

      await sweep({ lastSeen: seconds(-1), startedAgoMinutes: 60 }).execute();

      expect(await failureOf(id)).toBe('controller_lost');
    });

    it('fails a build report_overdue though its heartbeat is fresh', async () => {
      const ids = await projects(1);
      const id = await insert(ids, {
        project: 0,
        status: 'claimed',
        requestedAt: -60,
        claimedAt: -26,
      });

      await sweep({ lastSeen: seconds(-1), startedAgoMinutes: 60 }).execute();

      expect(await failureOf(id)).toBe('report_overdue');
    });

    it('fails a requested operation not_claimed only while no controller is known to exist', async () => {
      const ids = await projects(2);
      const waiting = await insert(ids, { project: 0, status: 'requested', requestedAt: -6 });
      const other = await insert(ids, {
        project: 1,
        kind: 'stop',
        status: 'requested',
        requestedAt: -6,
      });

      await sweep({ lastSeen: seconds(-10), startedAgoMinutes: 60 }).execute();
      expect(await failureOf(waiting)).toBeNull();

      await sweep({ lastSeen: null, startedAgoMinutes: 0 }).execute();
      expect(await failureOf(waiting)).toBeNull();

      await sweep({ lastSeen: null, startedAgoMinutes: 60 }).execute();
      expect(await failureOf(waiting)).toBe('not_claimed');
      expect(await failureOf(other)).toBe('not_claimed');
    });

    it('deletes the snapshot of a failed claimed operation from the secret store', async () => {
      const ids = await projects(1);
      const id = await insert(ids, {
        project: 0,
        status: 'claimed',
        requestedAt: -60,
        claimedAt: -26,
      });
      const store = app.get<SecretStore>(SECRET_STORE);
      const secretId = await store.put('DB=sweep-value-0001', {
        owner: PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER,
      });
      await db().previewOperation.update({
        where: { id },
        data: { environmentFilePath: '.env', environmentFileSecretId: secretId },
      });

      await sweep({ lastSeen: seconds(-1), startedAgoMinutes: 60 }).execute();

      expect(await store.listOlderThan(PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER, 0)).not.toContain(
        secretId,
      );
      expect(
        await db().previewOperation.count({ where: { environmentFileSecretId: secretId } }),
      ).toBe(0);
    });
  });
});
