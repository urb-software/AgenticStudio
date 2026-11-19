import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Run } from '../../../domain/entities/run.js';
import { EnvironmentFileSnapshotRule } from '../../../domain/value-objects/environment-file-snapshot-rule.js';
import { PullRequestRefreshRule } from '../../../domain/value-objects/pull-request-refresh-rule.js';
import { RetentionPolicy } from '../../../domain/value-objects/retention-policy.js';
import { HandOutRule } from '../../../domain/value-objects/hand-out-rule.js';
import { GoneWorkerRule } from '../../../domain/value-objects/gone-worker-rule.js';
import { LeaseRenewalRule } from '../../../domain/value-objects/lease-renewal-rule.js';
import { LongWaitRule } from '../../../domain/value-objects/long-wait-rule.js';
import { LostWorkerRule } from '../../../domain/value-objects/lost-worker-rule.js';
import { OverdueStepRule } from '../../../domain/value-objects/overdue-step-rule.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../../platform/database/database.module.js';
import {
  startStudioApp,
  startStudioServices,
  type StudioServices,
} from '../../../../../__tests__/studio-test-app.js';

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
  /** What the hand-out rule takes, read from the entity's fields. */
  const handOutView = (run: Run) => ({
    id: run.id,
    projectId: run.projectId,
    createdAt: run.createdAt,
    state: run.lifecycle.state,
    claimedBy: run.claim.claimedBy,
    lastClaimedBy: run.claim.lastClaimedBy,
    sessionRef: run.claim.sessionRef,
    followUpQueued: run.progress.followUpQueued,
    deliveryRequested: run.delivery.requested,
  });
  const newestFirst = () => runs().listNewestFirst();
  const waiting = () => runs().listWaiting();
  const claimNext = (worker: string, now: Date) => runs().claimNext(worker, now);

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
    project: number;
    worker?: string;
    overrides?: Partial<RunData>;
  }

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

          for (let step = 0; step < 6; step++) {
            const stored = await newestFirst();
            const expected = HandOutRule.for(worker).next(stored.map(handOutView))?.id ?? null;
            const before = await snapshot();

            const handed = await claimNext(worker, NOW);

            expect(handed?.id ?? null).toBe(expected);
            const after = await snapshot();
            const changed = Object.keys(after).filter((id) => after[id] !== before[id]);
            if (handed === null) {
              expect(changed).toEqual([]);
              break;
            }
            expect(changed).toEqual([handed.id]);
            expect(handed.claim.claimedBy).toBe(worker);
            expect(handed.claim.heartbeatAt).toEqual(NOW);
          }
        });
      }
    }

    it('keeps the first start of a resumed Run and gives a claimed Follow-up its place', async () => {
      const [id] = await fixtures([{ kind: 'followUp', project: 1, worker: W1 }]);

      const handed = await claimNext(W1, NOW);

      expect(handed).toMatchObject({
        id,
        lifecycle: { state: 'preparing', startedAt: T },
        progress: { followUpQueued: false },
        claim: { lastClaimedBy: W1 },
      });
    });

    it('leaves a failed delivery retry failed, held by the worker', async () => {
      const [id] = await fixtures([{ kind: 'retry', project: 1, worker: W1 }]);

      const handed = await claimNext(W1, NOW);

      expect(handed).toMatchObject({
        id,
        lifecycle: { state: 'failed' },
        claim: { claimedBy: W1 },
        delivery: { requested: true },
      });
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
      const before = await newestFirst();
      const selected = new Map(
        before
          .filter((run) => rule.selects(run.sweepFacts()))
          .map((run) => [run.id, rule.resultFor(run.sweepFacts())]),
      );
      expect(selected.size).toBe(3);

      const count = await runs().failStaleClaims(
        rule.staleBefore,
        rule.failure,
        rule.deliveryFailure,
        NOW,
      );

      expect(count).toBe(selected.size);
      for (const run of await newestFirst()) {
        const result = selected.get(run.id);
        if (!result) {
          expect(before.find((candidate) => candidate.id === run.id)).toMatchObject({
            lifecycle: { state: run.lifecycle.state },
            claim: { claimedBy: run.claim.claimedBy },
          });
          continue;
        }
        expect(run).toMatchObject({
          lifecycle: { state: 'failed', failure: result.failure, finishedAt: NOW },
          claim: { claimedBy: null, heartbeatAt: null },
        });
        if (result.retryEnds) {
          expect(run).toMatchObject({ delivery: { requested: false, state: 'failed' } });
        } else {
          expect(run.delivery.requested).toBe(false);
        }
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
      const before = await newestFirst();
      const selected = new Set(
        before.filter((run) => rule.selects(run.sweepFacts())).map((run) => run.id),
      );
      expect(selected.size).toBe(1);

      const count = await runs().timeOutOverdueSteps(rule.now, rule.graceMinutes);

      expect(count).toBe(selected.size);
      for (const run of await newestFirst()) {
        if (selected.has(run.id)) {
          expect(run).toMatchObject({
            lifecycle: { state: 'timed_out', finishedAt: NOW },
            claim: { claimedBy: null },
          });
        } else {
          expect(run.lifecycle.state).toBe(
            before.find((candidate) => candidate.id === run.id)!.lifecycle.state,
          );
        }
      }
    });
  });

  describe('the long-wait sweep and LongWaitRule', () => {
    it('cancels exactly the Runs the rule selects, among the Runs waiting for the operator', async () => {
      const waitedFor = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
      await fixtures([
        { kind: 'waiting', project: 1, overrides: { waitingSince: waitedFor(15) } },
        { kind: 'waiting', project: 2, overrides: { waitingSince: waitedFor(13) } },
        {
          kind: 'waiting',
          project: 3,
          overrides: { waitingSince: waitedFor(30), limitWaitingDays: 60 },
        },
        { kind: 'waiting', project: 4, overrides: { waitingSince: waitedFor(40) } },
        { kind: 'fresh', project: 5 },
        { kind: 'running', project: 6 },
      ]);
      const rule = LongWaitRule.at(NOW);
      const before = await newestFirst();
      const candidates = before
        .filter((run) => rule.candidate(run.sweepFacts()))
        .map((run) => run.id);
      const selected = new Set(
        before.filter((run) => rule.selects(run.sweepFacts())).map((run) => run.id),
      );
      expect(selected.size).toBe(2);

      const listed = await waiting();
      expect(listed.map((run) => run.id).sort()).toEqual([...candidates].sort());
      for (const run of listed) {
        const cancellation = rule.cancellationFor(run.sweepFacts());
        if (!cancellation) continue;
        let done = false;
        await runs().change(run.id, (r) => {
          done = r.cancelAfterWaiting(cancellation, NOW);
        });
        expect(done).toBe(true);
      }

      for (const run of await newestFirst()) {
        if (selected.has(run.id)) {
          expect(run).toMatchObject({
            lifecycle: { state: 'cancelled', cancellation: { by: 'system' }, finishedAt: NOW },
          });
        } else {
          expect(run.lifecycle.state).toBe(
            before.find((candidate) => candidate.id === run.id)!.lifecycle.state,
          );
        }
      }
      const [cancelled] = [...selected];
      let again = true;
      await runs().change(cancelled!, (r) => {
        again = r.cancelAfterWaiting({ by: 'system', reason: 'again' }, NOW);
      });
      expect(again).toBe(false);
    });
  });

  describe('the gone-worker sweeps and GoneWorkerRule', () => {
    it('lists and gives up exactly the Runs the rule calls pending', async () => {
      await fixtures([
        { kind: 'retry', project: 1, worker: W1 },
        { kind: 'retryHeld', project: 2, worker: W2 },
        { kind: 'failed', project: 3 },
        { kind: 'answered', project: 4, worker: W1 },
        { kind: 'followUp', project: 5, worker: W2 },
        { kind: 'fresh', project: 6 },
        { kind: 'waiting', project: 7 },
      ]);
      const rule = GoneWorkerRule.at(NOW, LEASE_SECONDS);
      const before = await newestFirst();
      const retries = before.filter((run) => rule.pendingDeliveryRetry(run.sweepFacts()));
      const resumes = before.filter((run) => rule.pendingResume(run.sweepFacts()));
      expect(retries).toHaveLength(1);
      expect(resumes).toHaveLength(2);
      const failure = { code: 'delivery_failed', detail: 'gone' } as const;

      const listedRetries = await runs().listPendingDeliveryRetries();
      const listedResumes = await runs().listPendingResumes();

      expect(listedRetries).toEqual(
        retries.map((run) => ({ runId: run.id, startedBy: run.claim.lastClaimedBy })),
      );
      expect(listedResumes.map((entry) => entry.runId).sort()).toEqual(
        resumes.map((run) => run.id).sort(),
      );
      expect(listedResumes.map((entry) => entry.startedBy).sort()).toEqual(
        resumes.map((run) => run.claim.lastClaimedBy).sort(),
      );
      for (const run of before) {
        const pendingRetry = rule.pendingDeliveryRetry(run.sweepFacts());
        const pendingResume = rule.pendingResume(run.sweepFacts());
        let abandonedRetry = false;
        await runs().change(run.id, (r) => {
          abandonedRetry = r.abandonDeliveryRetry(failure, NOW);
        });
        expect(abandonedRetry).toBe(pendingRetry);
        let abandonedResume = false;
        await runs().change(run.id, (r) => {
          abandonedResume = r.abandonResume({ code: 'preparation_failed', detail: 'gone' }, NOW);
        });
        expect(abandonedResume).toBe(pendingResume);
      }
    });
  });

  describe('the lease renewal and LeaseRenewalRule', () => {
    it('renews exactly the Runs the rule names, at most once per lease', async () => {
      await db().$executeRaw`TRUNCATE TABLE run_lease_renewals`;
      await fixtures([
        { kind: 'preparing', project: 1 },
        { kind: 'running', project: 2 },
        { kind: 'retryHeld', project: 3 },
        { kind: 'waiting', project: 4 },
        { kind: 'fresh', project: 5 },
      ]);
      const rule = LeaseRenewalRule.at(NOW, LEASE_SECONDS);
      const before = await newestFirst();
      const renewed = before.filter((run) => rule.renews(run.sweepFacts()));
      expect(rule.isDue(null)).toBe(true);

      expect(await runs().renewClaimsOncePerLease(NOW, LEASE_SECONDS)).toBe(renewed.length);

      for (const run of await newestFirst()) {
        const was = before.find((candidate) => candidate.id === run.id)!;
        expect(run.claim.heartbeatAt).toEqual(
          rule.renews(run.sweepFacts()) ? NOW : was.claim.heartbeatAt,
        );
      }
      const soon = new Date(NOW.getTime() + 30_000);
      expect(LeaseRenewalRule.at(soon, LEASE_SECONDS).isDue(NOW)).toBe(false);
      expect(await runs().renewClaimsOncePerLease(soon, LEASE_SECONDS)).toBeNull();
      const later = new Date(NOW.getTime() + LEASE_SECONDS * 1000);
      expect(LeaseRenewalRule.at(later, LEASE_SECONDS).isDue(NOW)).toBe(true);
      expect(await runs().renewClaimsOncePerLease(later, LEASE_SECONDS)).toBe(renewed.length);
    });
  });

  const DAY = 24 * 60 * 60 * 1000;
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const WORKING_COPY = { runBranch: 'agent/x-r1', commits: [], hasUncommittedChanges: false };
  const withPullRequest = (number: number) => ({
    delivery: 'delivered',
    pullRequestUrl: `https://git.example.test/acme/shop/pull/${number}`,
    pullRequestNumber: number,
  });

  describe('the Environment file snapshot release and EnvironmentFileSnapshotRule', () => {
    const snapshot = () => ({
      environmentFileSupplied: true,
      environmentFilePath: '.env',
      environmentFileSecretId: randomUUID(),
    });
    const rule = EnvironmentFileSnapshotRule.at(NOW, 7);
    const retryable = (failureCode: string, finishedAt: Date, deliveryRequested = false) => ({
      ...snapshot(),
      failureCode,
      delivery: failureCode === 'delivery_failed' ? 'failed' : null,
      deliveryRequested,
      finishedAt,
    });

    it('lists exactly the Runs holding a snapshot that the rule releases', async () => {
      const edge = rule.retryableFinishedBefore;
      await fixtures([
        { kind: 'running', project: 1, overrides: snapshot() },
        { kind: 'succeeded', project: 2, overrides: snapshot() },
        { kind: 'succeeded', project: 3 },
        { kind: 'failed', project: 4, overrides: snapshot() },
        { kind: 'retry', project: 5, overrides: retryable('delivery_failed', ago(DAY), true) },
        { kind: 'retry', project: 6, overrides: retryable('delivery_failed', ago(DAY)) },
        { kind: 'retry', project: 7, overrides: retryable('delivery_failed', ago(8 * DAY)) },
        { kind: 'retry', project: 8, overrides: retryable('delivery_failed', edge) },
        {
          kind: 'retry',
          project: 9,
          overrides: retryable('delivery_failed', new Date(edge.getTime() - 1)),
        },
        { kind: 'retry', project: 10, overrides: retryable('usage_limit', ago(DAY)) },
        { kind: 'retry', project: 11, overrides: retryable('usage_limit', ago(9 * DAY)) },
        { kind: 'retry', project: 12, overrides: retryable('usage_limit', ago(9 * DAY), true) },
      ]);
      const held = new Map(
        (await db().run.findMany({ select: { id: true, environmentFileSecretId: true } })).map(
          (row) => [row.id, row.environmentFileSecretId],
        ),
      );
      const all = await newestFirst();
      const expected = all
        .filter((run) => held.get(run.id) && rule.releasable(run.snapshotFacts()))
        .map((run) => run.id);

      const listed = await runs().listReleasableEnvironmentFileSecrets(
        rule.retryableFinishedBefore,
      );

      expect(expected.length).toBeGreaterThan(0);
      expect(expected.length).toBeLessThan(all.length);
      expect(listed.map((entry) => entry.runId).sort()).toEqual([...expected].sort());
      for (const entry of listed) expect(entry.secretRef).toBe(held.get(entry.runId));
    });
  });

  describe('the per-Project limit and RetentionPolicy', () => {
    const policy = RetentionPolicy.of({
      days: 7,
      maxPerProject: 5,
      openPullRequestIdleDays: 14,
      hoursAfterPullRequestEnd: 24,
    });

    it('lists exactly the Runs the policy counts against the limit', async () => {
      await fixtures([
        { kind: 'succeeded', project: 1, overrides: WORKING_COPY },
        { kind: 'failed', project: 1, overrides: WORKING_COPY },
        { kind: 'succeeded', project: 1 },
        { kind: 'succeeded', project: 1, overrides: { ...WORKING_COPY, workingCopyRemovedAt: T } },
        { kind: 'succeeded', project: 2, overrides: { ...WORKING_COPY, ...withPullRequest(4) } },
        { kind: 'running', project: 2, overrides: WORKING_COPY },
        { kind: 'fresh', project: 2 },
        { kind: 'succeeded', project: 2, overrides: WORKING_COPY },
      ]);
      const all = await newestFirst();
      const expected = all
        .filter((run) =>
          policy.countsAgainstLimit({
            state: run.lifecycle.state,
            finishedAt: run.lifecycle.finishedAt,
            hasPullRequest: run.delivery.hasPullRequest,
            hasWorkingCopy: run.workingCopy !== null,
            workingCopyRemoved: run.claim.workingCopyRemoved,
          }),
        )
        .map((run) => run.id);

      const listed = await runs().findLimitedRuns([...new Set(all.map((run) => run.projectId))]);

      expect(expected.length).toBeGreaterThan(0);
      expect(expected.length).toBeLessThan(all.length);
      expect(listed.map((entry) => entry.runId).sort()).toEqual([...expected].sort());
    });
  });

  describe('the daily pull request refresh and PullRequestRefreshRule', () => {
    const rule = PullRequestRefreshRule.at(NOW);
    const status = (
      prState: string | null,
      refreshedAt: Date | null,
      extra: Partial<RunData> = {},
    ) =>
      ({
        ...WORKING_COPY,
        ...withPullRequest(7),
        prState,
        prRefreshedAt: prState === null ? null : refreshedAt,
        ...extra,
      }) as Partial<RunData>;

    it('lists exactly the due Runs, in the order of the rule', async () => {
      const old = ago(2 * DAY);
      await fixtures([
        { kind: 'succeeded', project: 1, overrides: status(null, null) },
        { kind: 'succeeded', project: 2, overrides: status(null, null) },
        { kind: 'succeeded', project: 3, overrides: status('open', old) },
        {
          kind: 'succeeded',
          project: 4,
          overrides: status('draft', old, { prLastAttemptAt: ago(3 * DAY) }),
        },
        {
          kind: 'succeeded',
          project: 5,
          overrides: status('open', old, { prLastAttemptAt: ago(2 * DAY) }),
        },
        {
          kind: 'succeeded',
          project: 6,
          overrides: status('open', old, { prLastAttemptAt: ago(DAY / 2) }),
        },
        { kind: 'succeeded', project: 7, overrides: status('open', ago(DAY / 2)) },
        { kind: 'succeeded', project: 8, overrides: status('merged', old) },
        { kind: 'succeeded', project: 9, overrides: status('closed', old) },
        {
          kind: 'succeeded',
          project: 10,
          overrides: status('open', old, { prRefreshRequestedAt: old }),
        },
        { kind: 'succeeded', project: 11, overrides: withPullRequest(8) },
        { kind: 'succeeded', project: 12, overrides: WORKING_COPY },
        {
          kind: 'succeeded',
          project: 13,
          overrides: status('open', old, { prLastAttemptAt: ago(DAY) }),
        },
      ]);
      const facts = (await newestFirst()).map((run) => run.pullRequestRefreshFacts());
      const expected = facts
        .filter((candidate) => rule.dueDaily(candidate))
        .sort((a, b) => rule.dailyOrder(a, b))
        .map((candidate) => candidate.id);

      const listed = await runs().listDueForDailyRefresh(
        rule.staleBefore,
        PullRequestRefreshRule.BATCH,
      );

      expect(expected.length).toBeGreaterThan(2);
      expect(expected.length).toBeLessThan(facts.length);
      expect(listed).toEqual(expected);
      expect(await runs().listDueForDailyRefresh(rule.staleBefore, 2)).toEqual(
        expected.slice(0, 2),
      );
    });
  });
});
