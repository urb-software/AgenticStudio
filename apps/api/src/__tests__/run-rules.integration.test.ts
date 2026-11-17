import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HandOutRule } from '../modules/executions/domain/value-objects/hand-out-rule.js';
import {
  LostWorkerRule,
  OverdueStepRule,
} from '../modules/executions/domain/value-objects/run-sweep-rules.js';
import {
  RUN_REPOSITORY,
  type RunRepository,
} from '../modules/executions/domain/repositories/run-repository.js';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { startStudioApp, startStudioServices, type StudioServices } from './studio-test-app.js';

// Issue #169 (Epic #160): the Run repository keeps the hand-out and the sweeps over many Runs, each
// paired with a named rule in the domain. Here the store's statements are run over fixture rows of
// every kind and must select and change exactly what the rule says on the same rows.

const T = new Date('2026-11-17T09:00:00.000Z');
const NOW = new Date('2026-11-17T12:00:00.000Z');
const LEASE_SECONDS = 60;
const W1 = randomUUID();
const W2 = randomUUID();
const W3 = randomUUID();

type RunData = Parameters<DatabaseClient['run']['create']>[0]['data'];

describe('the store follows the rules of the domain (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const runs = () => app.get<RunRepository>(RUN_REPOSITORY);

  beforeAll(async () => {
    services = await startStudioServices();
    app = await startStudioApp(services.config);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
  });

  async function project(): Promise<string> {
    const name = `Shop ${randomUUID()}`;
    const [row] = await db().$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
      RETURNING id`;
    return row!.id;
  }

  /** The kinds of Run the hand-out and the sweeps tell apart, as rows the CHECK constraints allow. */
  const KINDS = {
    fresh: () => ({ state: 'queued' }),
    answered: (w: string) => ({
      state: 'queued',
      sessionRef: 'session-1',
      lastClaimedBy: w,
      startedAt: T,
    }),
    followUp: (w: string) => ({
      state: 'queued',
      sessionRef: 'session-1',
      lastClaimedBy: w,
      startedAt: T,
      followUpQueued: true,
      followUpCount: 1,
    }),
    preparing: (w: string) => ({
      state: 'preparing',
      claimedBy: w,
      lastClaimedBy: w,
      heartbeatAt: T,
      startedAt: T,
    }),
    running: (w: string) => ({
      state: 'running',
      claimedBy: w,
      lastClaimedBy: w,
      heartbeatAt: T,
      startedAt: T,
      stepStartedAt: T,
    }),
    waiting: (w: string) => ({
      state: 'waiting_for_operator',
      waitingSince: T,
      startedAt: T,
      lastClaimedBy: w,
      releasedBy: w,
    }),
    retry: (w: string) => ({
      state: 'failed',
      failureCode: 'delivery_failed',
      failureDetail: 'x',
      delivery: 'failed',
      deliveryRequested: true,
      finishedAt: T,
      startedAt: T,
      lastClaimedBy: w,
      releasedBy: w,
    }),
    retryHeld: (w: string) => ({
      state: 'failed',
      failureCode: 'delivery_failed',
      failureDetail: 'x',
      delivery: 'failed',
      deliveryRequested: true,
      finishedAt: T,
      startedAt: T,
      lastClaimedBy: w,
      claimedBy: w,
      heartbeatAt: T,
    }),
    failed: (w: string) => ({
      state: 'failed',
      failureCode: 'agent_failed',
      failureDetail: 'x',
      finishedAt: T,
      startedAt: T,
      lastClaimedBy: w,
      releasedBy: w,
    }),
    succeeded: (w: string) => ({
      state: 'succeeded',
      finishedAt: T,
      startedAt: T,
      lastClaimedBy: w,
      releasedBy: w,
    }),
  } satisfies Record<string, (worker: string) => Partial<RunData>>;

  type Kind = keyof typeof KINDS;
  interface Spec {
    kind: Kind;
    /** The project's number: Runs of one number share a project. */
    project: number;
    worker?: string;
    overrides?: Partial<RunData>;
  }

  /** Replaces all Runs by the specs, oldest first; returns the ids in that order. */
  async function fixtures(specs: readonly Spec[]): Promise<string[]> {
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    const projects = new Map<number, string>();
    const ids: string[] = [];
    for (const [n, spec] of specs.entries()) {
      if (!projects.has(spec.project)) projects.set(spec.project, await project());
      const created = await db().run.create({
        data: {
          projectId: projects.get(spec.project)!,
          provider: 'codex',
          task: 'Add a health check',
          startCommit: 'a'.repeat(40),
          remoteUrl: 'https://git.example.test/acme/shop.git',
          integrationBranch: 'dev',
          limitStepMinutes: 60,
          limitMaxSteps: 5,
          limitWaitingDays: 14,
          createdAt: new Date(T.getTime() - 3600_000 + n * 1000),
          ...KINDS[spec.kind](spec.worker ?? W1),
          ...spec.overrides,
        } as RunData,
        select: { id: true },
      });
      ids.push(created.id);
    }
    return ids;
  }

  const snapshot = async () =>
    Object.fromEntries(
      (
        await db().$queryRaw<{ id: string; state: string; claimed_by: string | null }[]>`
          SELECT id, state, claimed_by FROM runs`
      ).map((row) => [row.id, `${row.state}/${row.claimed_by}`]),
    );

  describe('the hand-out and HandOutRule', () => {
    const SCENARIOS: Record<string, Spec[]> = {
      'the oldest queued Run first, one per project': [
        { kind: 'fresh', project: 1 },
        { kind: 'fresh', project: 1 },
        { kind: 'fresh', project: 2 },
        { kind: 'fresh', project: 3 },
      ],
      'one Run of a project holds its place': [
        { kind: 'running', project: 1 },
        { kind: 'fresh', project: 1 },
        { kind: 'fresh', project: 2 },
      ],
      'the server-wide limit': [
        { kind: 'running', project: 1 },
        { kind: 'waiting', project: 2 },
        { kind: 'fresh', project: 3 },
        { kind: 'fresh', project: 4 },
      ],
      'an answered Run belongs to the worker that started it': [
        { kind: 'answered', project: 1, worker: W1 },
        { kind: 'fresh', project: 2 },
        { kind: 'fresh', project: 3 },
      ],
      'an answered Run of another worker holds its place': [
        { kind: 'answered', project: 1, worker: W2 },
        { kind: 'fresh', project: 1 },
        { kind: 'fresh', project: 2 },
      ],
      'a Run queued for a Follow-up holds no place': [
        { kind: 'followUp', project: 1, worker: W2 },
        { kind: 'fresh', project: 1 },
        { kind: 'fresh', project: 2 },
      ],
      'a requested delivery retry belongs to the worker that started the Run': [
        { kind: 'retry', project: 1, worker: W1 },
        { kind: 'fresh', project: 2 },
        { kind: 'failed', project: 3, worker: W1 },
      ],
      'a delivery retry a worker holds holds a place': [
        { kind: 'retryHeld', project: 1, worker: W2 },
        { kind: 'fresh', project: 1 },
        { kind: 'fresh', project: 2 },
        { kind: 'fresh', project: 3 },
      ],
      'nothing eligible': [
        { kind: 'succeeded', project: 1 },
        { kind: 'failed', project: 2 },
        { kind: 'preparing', project: 3 },
      ],
    };

    for (const [name, specs] of Object.entries(SCENARIOS)) {
      for (const worker of [W1, W2, W3]) {
        it(`hands out what the rule says: ${name} (worker ${[W1, W2, W3].indexOf(worker) + 1})`, async () => {
          await fixtures(specs);

          // Claim until nothing is handed out: every step is the rule's choice on the rows as
          // they stand, and changes that Run only.
          for (let step = 0; step < 6; step++) {
            const stored = await runs().listNewestFirst();
            const expected = HandOutRule.for(worker).next(stored)?.id ?? null;
            const before = await snapshot();

            const handed = await runs().claimNext(worker, NOW);

            expect(handed?.id ?? null).toBe(expected);
            const after = await snapshot();
            const changed = Object.keys(after).filter((id) => after[id] !== before[id]);
            if (handed === null) {
              expect(changed).toEqual([]);
              break;
            }
            expect(changed.length).toBeLessThanOrEqual(1);
            expect(handed.claimedBy).toBe(worker);
            expect(handed.heartbeatAt).toEqual(NOW);
          }
        });
      }
    }

    it('keeps the first start of a resumed Run and gives a claimed Follow-up its place', async () => {
      const [id] = await fixtures([{ kind: 'followUp', project: 1, worker: W1 }]);

      const handed = await runs().claimNext(W1, NOW);

      expect(handed).toMatchObject({
        id,
        state: 'preparing',
        startedAt: T,
        followUpQueued: false,
        lastClaimedBy: W1,
      });
    });

    it('leaves a failed delivery retry failed, held by the worker', async () => {
      const [id] = await fixtures([{ kind: 'retry', project: 1, worker: W1 }]);

      const handed = await runs().claimNext(W1, NOW);

      expect(handed).toMatchObject({ id, state: 'failed', claimedBy: W1, deliveryRequested: true });
    });
  });

  describe('the lost-worker sweep and LostWorkerRule', () => {
    const stale = new Date(NOW.getTime() - (LEASE_SECONDS + 1) * 1000);
    const fresh = new Date(NOW.getTime() - (LEASE_SECONDS - 1) * 1000);
    const SPECS: Spec[] = [
      { kind: 'preparing', project: 1, overrides: { heartbeatAt: stale } },
      { kind: 'running', project: 2, overrides: { heartbeatAt: stale } },
      { kind: 'running', project: 3, overrides: { heartbeatAt: fresh } },
      { kind: 'retryHeld', project: 4, overrides: { heartbeatAt: stale } },
      { kind: 'retryHeld', project: 5, overrides: { heartbeatAt: fresh } },
      { kind: 'waiting', project: 6 },
      { kind: 'fresh', project: 7 },
      { kind: 'succeeded', project: 8 },
    ];

    it('fails exactly the Runs the rule selects, with the results it gives', async () => {
      const ids = await fixtures(SPECS);
      const rule = LostWorkerRule.at(NOW, LEASE_SECONDS);
      const before = await runs().listNewestFirst();
      const selected = new Map(
        before.filter((run) => rule.selects(run)).map((run) => [run.id, rule.resultFor(run)]),
      );
      expect(selected.size).toBe(3);

      const count = await runs().failStaleClaims(
        rule.staleBefore,
        rule.failure,
        rule.deliveryFailure,
        NOW,
      );

      expect(count).toBe(selected.size);
      for (const run of await runs().listNewestFirst()) {
        const result = selected.get(run.id);
        if (!result) {
          expect(before.find((candidate) => candidate.id === run.id)).toMatchObject({
            state: run.state,
            claimedBy: run.claimedBy,
          });
          continue;
        }
        expect(run).toMatchObject({
          state: 'failed',
          failure: result.failure,
          claimedBy: null,
          heartbeatAt: null,
          finishedAt: NOW,
        });
        expect(run.deliveryRequested).toBe(result.retryEnds ? false : run.deliveryRequested);
      }
      expect(ids).toHaveLength(SPECS.length);
    });
  });

  describe('the step time-limit sweep and OverdueStepRule', () => {
    it('times out exactly the Runs the rule selects', async () => {
      const startedAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
      await fixtures([
        { kind: 'running', project: 1, overrides: { stepStartedAt: startedAgo(66) } },
        { kind: 'running', project: 2, overrides: { stepStartedAt: startedAgo(64) } },
        { kind: 'running', project: 3, overrides: { stepStartedAt: null } },
        {
          kind: 'running',
          project: 4,
          overrides: { stepStartedAt: startedAgo(500), limitStepMinutes: 600 },
        },
        { kind: 'preparing', project: 5 },
        { kind: 'waiting', project: 6 },
      ]);
      const rule = OverdueStepRule.at(NOW, 5);
      const before = await runs().listNewestFirst();
      const selected = new Set(before.filter((run) => rule.selects(run)).map((run) => run.id));
      expect(selected.size).toBe(1);

      const count = await runs().timeOutOverdueSteps(rule.now, rule.graceMinutes);

      expect(count).toBe(selected.size);
      for (const run of await runs().listNewestFirst()) {
        if (selected.has(run.id)) {
          expect(run).toMatchObject({ state: 'timed_out', claimedBy: null, finishedAt: NOW });
        } else {
          expect(run.state).toBe(before.find((candidate) => candidate.id === run.id)!.state);
        }
      }
    });
  });
});
