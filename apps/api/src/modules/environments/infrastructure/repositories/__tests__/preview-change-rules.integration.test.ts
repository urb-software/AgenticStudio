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
import { PreviewOperation } from '../../../domain/entities/preview-operation.js';
import {
  PreviewBuildRunningError,
  PreviewBusyError,
  PreviewLimitReachedError,
} from '../../../domain/errors/preview-settings-errors.js';
import { InMemoryPreviewOperationRepository } from '../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../../../domain/repositories/preview-operation-repository.js';
import { PreviewDisconnectRule } from '../../../domain/value-objects/preview-disconnect-rule.js';
import { PreviewRunningLimitRule } from '../../../domain/value-objects/preview-running-limit-rule.js';
import { PreviewRunningRule } from '../../../domain/value-objects/preview-running-rule.js';
import { PreviewStartLimit } from '../../../domain/value-objects/preview-start-limit.js';
import { StateCheckRule } from '../../../domain/value-objects/state-check-rule.js';
import { PreviewCommit } from '../../../domain/value-objects/preview-commit.js';
import { PreviewComposeFile } from '../../../domain/value-objects/preview-compose-file.js';
import { PreviewLimits } from '../../../domain/value-objects/preview-limits.js';
import { PreviewPort } from '../../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../../domain/value-objects/preview-service.js';

// The Preview stop, reset and limit statements of the store against the rules of the domain, the
// request lock, and the migration's CHECK and index (PostgreSQL + Redis via Testcontainers).

const NOW = new Date('2026-11-25T12:00:00.000Z');
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);

type Status = 'requested' | 'claimed' | 'succeeded' | 'failed';
type Kind = 'build' | 'stop' | 'remove_data' | 'state';

interface Spec {
  project: number;
  kind?: Kind;
  status: Status;
  requestedAt: number;
  finishedAt?: number;
  failureCode?: string;
  previewRemoved?: boolean;
  /** A final operation was claimed unless this says it never was. */
  neverClaimed?: boolean;
}

describe('the Preview stop, reset and limit store follows the rules of the domain (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const operations = () => app.get<PreviewOperationRepository>(PREVIEW_OPERATION_REPOSITORY);

  beforeAll(async () => {
    services = await startStudioServices();
    app = await startStudioApp(services.config, {
      environments: { sweeps: false },
      projects: { disconnectRetries: false },
    });
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
              buildMinutes: 20,
            }
          : {}),
        ...((claimed || final) && !spec.neverClaimed
          ? { claimedBy: randomUUID(), claimedAt: minutes(spec.requestedAt) }
          : {}),
        ...(claimed ? { heartbeatAt: NOW } : {}),
        ...(final ? { finishedAt: minutes(spec.finishedAt ?? spec.requestedAt + 1) } : {}),
        ...(spec.status === 'failed'
          ? {
              failureCode: spec.failureCode ?? 'build_failed',
              failureDetail: 'x',
              previewRemoved: !!spec.previewRemoved,
            }
          : {}),
        ...(spec.status === 'succeeded' && spec.previewRemoved ? { previewRemoved: true } : {}),
      },
    });
    return row.id;
  }

  /** The same fixture in memory, as the domain rules see it. */
  async function inMemory(): Promise<InMemoryPreviewOperationRepository> {
    const memory = new InMemoryPreviewOperationRepository();
    for (const row of await db().previewOperation.findMany()) {
      const failed = row.status === 'failed';
      const operation = PreviewOperation.restore({
        id: row.id,
        projectId: row.projectId,
        kind: row.kind as Kind,
        status: row.status as Status,
        build:
          row.kind === 'build'
            ? {
                commit: row.commit!,
                composeFile: row.composeFile!,
                service: row.service!,
                port: row.port!,
                limits: PreviewLimits.of({
                  memoryMiB: row.memoryMiB!,
                  cpuPercent: row.cpuPercent!,
                  tasksMax: row.tasksMax!,
                  buildMinutes: row.buildMinutes!,
                }).toData(),
              }
            : null,
        requestedAt: row.requestedAt,
        claimedBy: row.claimedBy,
        claimedAt: row.claimedAt,
        heartbeatAt: row.heartbeatAt,
        finishedAt: row.finishedAt,
        failure: failed
          ? { code: row.failureCode as 'build_failed', detail: 'x', refusals: [] }
          : null,
        previewRemoved: row.previewRemoved,
        result: null,
        environmentFile: null,
        log: { bytes: 0, truncated: false },
      });
      memory.operations.set(row.id, operation);
    }
    return memory;
  }

  const build = (projectId: string, id = randomUUID(), now = NOW) =>
    PreviewOperation.requestBuild({
      id,
      projectId,
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
      now,
    });
  const other = (projectId: string, kind: 'stop' | 'remove_data' | 'state', now = NOW) =>
    PreviewOperation.requestOther({ id: randomUUID(), projectId, kind, now });

  describe('the migration', () => {
    const CHANGE_INDEX = /preview_operations_one_active_change_per_project/;
    const CHECK = /preview_operations_preview_removed_check/;

    it('allows one requested or claimed stop or data removal per Project, and any number of finals', async () => {
      const ids = await projects(2);
      await insert(ids, { project: 0, kind: 'stop', status: 'requested', requestedAt: -5 });

      await expect(
        insert(ids, { project: 0, kind: 'stop', status: 'requested', requestedAt: -4 }),
      ).rejects.toThrow(CHANGE_INDEX);
      await expect(
        insert(ids, { project: 0, kind: 'remove_data', status: 'requested', requestedAt: -4 }),
      ).rejects.toThrow(CHANGE_INDEX);
      await expect(
        insert(ids, { project: 0, kind: 'remove_data', status: 'claimed', requestedAt: -4 }),
      ).rejects.toThrow(CHANGE_INDEX);
      await insert(ids, { project: 1, kind: 'remove_data', status: 'requested', requestedAt: -3 });
      await insert(ids, { project: 0, kind: 'stop', status: 'succeeded', requestedAt: -20 });
      await insert(ids, { project: 0, kind: 'remove_data', status: 'failed', requestedAt: -19 });
      await insert(ids, { project: 0, kind: 'state', status: 'requested', requestedAt: -18 });
      await insert(ids, { project: 0, kind: 'state', status: 'requested', requestedAt: -17 });
      await insert(ids, { project: 0, status: 'requested', requestedAt: -16 });
    });

    it('keeps preview_removed for a failed build and a succeeded state check only', async () => {
      const ids = await projects(1);
      const bad = async (spec: Spec) => {
        const id = await insert(ids, { ...spec, previewRemoved: false });
        await db().$executeRaw`
          UPDATE preview_operations SET preview_removed = true WHERE id = ${id}::uuid`;
      };

      await expect(
        bad({ project: 0, kind: 'state', status: 'failed', requestedAt: -5 }),
      ).rejects.toThrow(CHECK);
      await expect(
        bad({ project: 0, kind: 'stop', status: 'succeeded', requestedAt: -6 }),
      ).rejects.toThrow(CHECK);
      await expect(bad({ project: 0, status: 'succeeded', requestedAt: -7 })).rejects.toThrow(
        CHECK,
      );
      await expect(
        insert(ids, {
          project: 0,
          kind: 'state',
          status: 'succeeded',
          requestedAt: -8,
          previewRemoved: true,
        }),
      ).resolves.toBeTruthy();
      await expect(
        insert(ids, { project: 0, status: 'failed', requestedAt: -9, previewRemoved: true }),
      ).resolves.toBeTruthy();
    });

    it('maps the violation of the index to PreviewBusyError when a stop or a data removal is added', async () => {
      const ids = await projects(1);
      await operations().add(other(ids[0]!, 'stop'));

      await expect(operations().add(other(ids[0]!, 'remove_data'))).rejects.toBeInstanceOf(
        PreviewBusyError,
      );
      await expect(operations().add(other(ids[0]!, 'stop'))).rejects.toBeInstanceOf(
        PreviewBusyError,
      );
    });
  });

  describe('findPreviewFacts and PreviewRunningRule with the state check', () => {
    it('counts a succeeded state check that found nothing, and no other', async () => {
      const ids = await projects(3);
      await insert(ids, { project: 0, status: 'succeeded', requestedAt: -90 });
      await insert(ids, {
        project: 0,
        kind: 'state',
        status: 'succeeded',
        requestedAt: -50,
        finishedAt: -40,
        previewRemoved: true,
      });
      await insert(ids, { project: 1, status: 'succeeded', requestedAt: -90, finishedAt: -80 });
      await insert(ids, {
        project: 1,
        kind: 'state',
        status: 'succeeded',
        requestedAt: -50,
        finishedAt: -40,
      });
      await insert(ids, { project: 2, status: 'succeeded', requestedAt: -90, finishedAt: -80 });
      await insert(ids, {
        project: 2,
        kind: 'state',
        status: 'failed',
        requestedAt: -50,
        finishedAt: -40,
      });

      const memory = await inMemory();
      const rule = PreviewRunningRule.create();
      for (const projectId of ids) {
        const stored = await operations().findPreviewFacts(projectId);
        const modelled = await memory.findPreviewFacts(projectId);
        expect(stored.runningChange?.id).toBe(modelled.runningChange?.id);
        const own = [...memory.operations.values()].filter((op) => op.projectId === projectId);
        const counted = own.filter((op) =>
          rule.changesRunning({
            kind: op.kind,
            status: op.status,
            previewRemoved: op.previewRemoved,
          }),
        );
        expect(counted.length).toBeGreaterThan(0);
      }
      expect((await operations().findPreviewFacts(ids[0]!)).runningChange?.kind).toBe('state');
      expect((await operations().findPreviewFacts(ids[1]!)).runningChange?.kind).toBe('build');
      expect((await operations().findPreviewFacts(ids[2]!)).runningChange?.kind).toBe('build');
    });

    it('finds the newest stop or data removal by request time as the latest change', async () => {
      const ids = await projects(2);
      await insert(ids, { project: 0, kind: 'stop', status: 'succeeded', requestedAt: -30 });
      const newest = await insert(ids, {
        project: 0,
        kind: 'remove_data',
        status: 'failed',
        requestedAt: -20,
      });
      await insert(ids, { project: 0, kind: 'state', status: 'requested', requestedAt: -10 });
      await insert(ids, { project: 0, status: 'requested', requestedAt: -5 });

      expect((await operations().findPreviewFacts(ids[0]!)).latestChange?.id).toBe(newest);
      expect((await operations().findPreviewFacts(ids[1]!)).latestChange).toBeNull();
    });
  });

  describe('findOccupyingProjects and PreviewRunningLimitRule', () => {
    it('lists exactly the Projects the rule says take a place', async () => {
      const ids = await projects(9);
      // 0: running. 1: stopped. 2: running then a failed build that removed it. 3: building.
      // 4: running with a rebuild requested. 5: failed build only. 6: reset done after running.
      // 7: lost build whose state check found nothing. 8: never ran.
      await insert(ids, { project: 0, status: 'succeeded', requestedAt: -60 });
      await insert(ids, { project: 1, status: 'succeeded', requestedAt: -60 });
      await insert(ids, { project: 1, kind: 'stop', status: 'succeeded', requestedAt: -50 });
      await insert(ids, { project: 2, status: 'succeeded', requestedAt: -60 });
      await insert(ids, {
        project: 2,
        status: 'failed',
        requestedAt: -50,
        finishedAt: -40,
        previewRemoved: true,
      });
      await insert(ids, { project: 3, status: 'claimed', requestedAt: -5 });
      await insert(ids, { project: 4, status: 'succeeded', requestedAt: -60 });
      await insert(ids, { project: 4, status: 'requested', requestedAt: -5 });
      await insert(ids, { project: 5, status: 'failed', requestedAt: -60 });
      await insert(ids, { project: 6, status: 'succeeded', requestedAt: -60 });
      await insert(ids, { project: 6, kind: 'remove_data', status: 'succeeded', requestedAt: -50 });
      await insert(ids, { project: 7, status: 'succeeded', requestedAt: -60 });
      await insert(ids, {
        project: 7,
        status: 'failed',
        requestedAt: -50,
        failureCode: 'controller_lost',
      });
      await insert(ids, {
        project: 7,
        kind: 'state',
        status: 'succeeded',
        requestedAt: -40,
        previewRemoved: true,
      });

      const memory = await inMemory();
      const rule = PreviewRunningLimitRule.create();
      const expected: { projectId: string; state: string }[] = [];
      for (const projectId of ids) {
        const facts = await memory.findPreviewFacts(projectId);
        const state = rule.state({
          runningChange: facts.runningChange,
          buildActive:
            facts.latestBuild !== null &&
            (facts.latestBuild.status === 'requested' || facts.latestBuild.status === 'claimed'),
        });
        if (state !== null) expected.push({ projectId, state });
      }

      const stored = await operations().findOccupyingProjects();

      expect(stored).toEqual(expected.sort((a, b) => (a.projectId < b.projectId ? -1 : 1)));
      expect(new Set(stored.map((entry) => ids.indexOf(entry.projectId)))).toEqual(
        new Set([0, 3, 4]),
      );
      expect(stored.find((entry) => entry.projectId === ids[3])?.state).toBe('building');
      expect(stored.find((entry) => entry.projectId === ids[4])?.state).toBe('building');
      expect(stored.find((entry) => entry.projectId === ids[0])?.state).toBe('running');
    });
  });

  describe('findStateCheckProjects and StateCheckRule', () => {
    it('selects exactly the Projects whose newest operation the rule selects', async () => {
      const ids = await projects(7);
      // 0: lost. 1: overdue. 2: lost, then a state check (newest). 3: failed otherwise.
      // 4: lost, then a newer build requested. 5: unclaimed failure. 6: lost, never claimed.
      await insert(ids, {
        project: 0,
        status: 'failed',
        requestedAt: -30,
        failureCode: 'controller_lost',
      });
      await insert(ids, {
        project: 1,
        status: 'failed',
        requestedAt: -30,
        failureCode: 'report_overdue',
      });
      await insert(ids, {
        project: 2,
        status: 'failed',
        requestedAt: -30,
        failureCode: 'controller_lost',
      });
      await insert(ids, { project: 2, kind: 'state', status: 'requested', requestedAt: -20 });
      await insert(ids, { project: 3, status: 'failed', requestedAt: -30 });
      await insert(ids, {
        project: 4,
        status: 'failed',
        requestedAt: -30,
        failureCode: 'controller_lost',
      });
      await insert(ids, { project: 4, status: 'requested', requestedAt: -20 });
      await insert(ids, {
        project: 5,
        status: 'failed',
        requestedAt: -30,
        failureCode: 'not_claimed',
        neverClaimed: true,
      });
      await insert(ids, {
        project: 6,
        status: 'failed',
        requestedAt: -30,
        failureCode: 'controller_lost',
        neverClaimed: true,
      });

      const memory = await inMemory();
      const rule = StateCheckRule.create();
      const newest = new Map<string, PreviewOperation>();
      for (const operation of memory.operations.values()) {
        const held = newest.get(operation.projectId);
        if (!held || operation.requestedAt > held.requestedAt) {
          newest.set(operation.projectId, operation);
        }
      }
      const expected = [...newest.values()]
        .filter((operation) =>
          rule.selects({
            kind: operation.kind,
            status: operation.status,
            claimedAt: operation.claimedAt,
            failureCode: operation.failure?.code ?? null,
          }),
        )
        .map((operation) => operation.projectId)
        .sort();

      const stored = await operations().findStateCheckProjects();

      expect(stored).toEqual(expected);
      expect(new Set(stored.map((id) => ids.indexOf(id)))).toEqual(new Set([0, 1]));
    });
  });

  describe('findDisconnectFacts and PreviewDisconnectRule', () => {
    it('reads what the rule decides from, for each way a Project can stand', async () => {
      const ids = await projects(6);
      // 0: nothing. 1: a build never claimed. 2: ran, removal succeeded. 3: ran. 4: ran, removal
      // claimed. 5: ran, removal failed.
      await insert(ids, { project: 1, status: 'requested', requestedAt: -10 });
      await insert(ids, { project: 2, status: 'succeeded', requestedAt: -60 });
      await insert(ids, { project: 2, kind: 'remove_data', status: 'succeeded', requestedAt: -50 });
      await insert(ids, { project: 3, status: 'succeeded', requestedAt: -60 });
      await insert(ids, { project: 4, status: 'succeeded', requestedAt: -60 });
      await insert(ids, { project: 4, kind: 'remove_data', status: 'claimed', requestedAt: -50 });
      await insert(ids, { project: 5, status: 'succeeded', requestedAt: -60 });
      await insert(ids, { project: 5, kind: 'remove_data', status: 'failed', requestedAt: -50 });

      const rule = PreviewDisconnectRule.create();
      const next = async (index: number) =>
        rule.next(await operations().findDisconnectFacts(ids[index]!));

      expect(await Promise.all([0, 1, 2, 3, 4, 5].map(next))).toEqual([
        'forget_settings',
        'forget_everything',
        'forget_everything',
        'request_removal',
        'wait_for_removal',
        'request_removal',
      ]);
    });

    it('keeps the operations when a build was claimed after the facts were read', async () => {
      const ids = await projects(1);
      const claimed = await insert(ids, { project: 0, status: 'requested', requestedAt: -10 });
      const rule = PreviewDisconnectRule.create();
      const decided = rule.next(await operations().findDisconnectFacts(ids[0]!));
      expect(decided).toBe('forget_everything');

      const claimedNow = await operations().claimNext(randomUUID(), NOW);
      expect(claimedNow?.id).toBe(claimed);
      const deleted = await operations().deleteForDisconnect(
        ids[0]!,
        (facts) => rule.next(facts) === 'forget_everything',
      );

      expect(deleted).toBe(false);
      expect(await db().previewOperation.count({ where: { projectId: ids[0]! } })).toBe(1);
    });

    it('deletes the operations of one Project with their log lines, and no other', async () => {
      const ids = await projects(2);
      const mine = await insert(ids, { project: 0, status: 'succeeded', requestedAt: -60 });
      const theirs = await insert(ids, { project: 1, status: 'succeeded', requestedAt: -60 });
      await db().previewOperationLine.create({
        data: { operationId: mine, seq: 1, at: NOW, stream: 'build', text: 'x' },
      });

      const rule = PreviewDisconnectRule.create();
      expect(
        await operations().deleteForDisconnect(
          ids[0]!,
          (facts) => rule.next(facts) === 'forget_everything',
        ),
      ).toBe(true);

      expect(await db().previewOperation.count({ where: { projectId: ids[0]! } })).toBe(0);
      expect(await db().previewOperationLine.count()).toBe(0);
      expect(await db().previewOperation.findUnique({ where: { id: theirs } })).not.toBeNull();
    });
  });

  describe('request under the lock', () => {
    it('gives one 202-equivalent and one refusal for two requests that race for the last place', async () => {
      const ids = await projects(3);
      await insert(ids, { project: 0, status: 'succeeded', requestedAt: -60 });
      const limit = PreviewStartLimit.of(2);
      const decide = (projectId: string) => () =>
        operations().request(projectId, (facts) => {
          const taken = limit.refusal({ projectId, occupying: facts.occupying });
          if (taken !== null) throw new PreviewLimitReachedError(limit.max, taken);
          return [build(projectId)];
        });

      const results = await Promise.allSettled([decide(ids[1]!)(), decide(ids[2]!)()]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((result) => result.status === 'rejected');
      expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(PreviewLimitReachedError);
      expect(await db().previewOperation.count({ where: { status: 'requested' } })).toBe(1);
    });

    it('lets a rebuild of a running Preview through at the limit', async () => {
      const ids = await projects(2);
      await insert(ids, { project: 0, status: 'succeeded', requestedAt: -60 });
      await insert(ids, { project: 1, status: 'succeeded', requestedAt: -60 });
      const limit = PreviewStartLimit.of(2);

      const [created] = await operations().request(ids[0]!, (facts) => {
        const taken = limit.refusal({ projectId: ids[0]!, occupying: facts.occupying });
        if (taken !== null) throw new PreviewLimitReachedError(limit.max, taken);
        return [build(ids[0]!)];
      });

      expect(created?.status).toBe('requested');
    });

    it('stores a data removal and a build together or not at all', async () => {
      const ids = await projects(1);
      await insert(ids, { project: 0, kind: 'remove_data', status: 'requested', requestedAt: -5 });

      await expect(
        operations().request(ids[0]!, () => [
          build(ids[0]!),
          other(ids[0]!, 'remove_data', minutes(1)),
        ]),
      ).rejects.toBeInstanceOf(PreviewBusyError);

      expect(await db().previewOperation.count({ where: { kind: 'build' } })).toBe(0);
    });

    it('answers two stops with one stored and one busy', async () => {
      const ids = await projects(1);

      const results = await Promise.allSettled([
        operations().request(ids[0]!, () => [other(ids[0]!, 'stop')]),
        operations().request(ids[0]!, () => [other(ids[0]!, 'stop')]),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(
        (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
      ).toBeInstanceOf(PreviewBusyError);
    });

    it('refuses a second active build as PreviewBuildRunningError', async () => {
      const ids = await projects(1);
      await operations().request(ids[0]!, () => [build(ids[0]!)]);

      await expect(
        operations().request(ids[0]!, () => [build(ids[0]!, randomUUID(), minutes(1))]),
      ).rejects.toBeInstanceOf(PreviewBuildRunningError);
    });
  });
});
