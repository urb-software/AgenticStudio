import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../../domain/repositories/run-lookup-repository.js';
import { LookupHandOutRule } from '../../../domain/value-objects/lookup-hand-out-rule.js';
import { type LookupHandOutView } from '../../../domain/value-objects/lookup-hand-out-view.js';
import { type LookupRunView } from '../../../domain/value-objects/lookup-run-view.js';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../../platform/database/database.module.js';
import {
  startStudioApp,
  startStudioServices,
  type StudioServices,
} from '../../../../../__tests__/studio-test-app.js';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const LEASE_SECONDS = 120;
const WORKER = randomUUID();
const OTHER = randomUUID();
const seconds = (count: number) => new Date(NOW.getTime() + count * 1000);

describe('the lookup store follows the rule of the domain (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const lookups = () => app.get<RunLookupRepository>(RUN_LOOKUP_REPOSITORY);

  beforeAll(async () => {
    services = await startStudioServices();
    app = await startStudioApp(services.config);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
  });

  interface RunSpec {
    pullRequest: boolean;
    branch: boolean;
  }

  interface LookupSpec {
    run: number;
    status: 'requested' | 'claimed' | 'done' | 'failed';
    requestedAt: number;
    claimedAt?: number;
    retryAt?: number;
  }

  async function fixtures(runSpecs: RunSpec[], lookupSpecs: LookupSpec[]) {
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    const runIds: string[] = [];
    for (const [index, spec] of runSpecs.entries()) {
      const name = `Shop ${randomUUID()}`;
      const [project] = await db().$queryRaw<{ id: string }[]>`
        INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
        RETURNING id`;
      const created = await db().run.create({
        data: {
          projectId: project!.id,
          provider: 'codex',
          task: 'Add a health check',
          startCommit: 'a'.repeat(40),
          remoteUrl: 'https://git.example.test/acme/shop.git',
          integrationBranch: 'dev',
          limitStepMinutes: 60,
          limitMaxSteps: 5,
          limitWaitingDays: 14,
          state: 'succeeded',
          startedAt: seconds(-7200),
          finishedAt: seconds(-3600),
          lastClaimedBy: WORKER,
          releasedBy: WORKER,
          createdAt: seconds(-86_400 + index),
          ...(spec.pullRequest
            ? { pullRequestUrl: 'https://github.com/acme/shop/pull/7', pullRequestNumber: 7 }
            : {}),
          ...(spec.branch
            ? { runBranch: 'agent/x-r1', commits: [], hasUncommittedChanges: false }
            : {}),
        },
        select: { id: true },
      });
      runIds.push(created.id);
    }
    const ids: string[] = [];
    for (const spec of lookupSpecs) {
      const done = spec.status === 'done' || spec.status === 'failed';
      const created = await db().runLookup.create({
        data: {
          runId: runIds[spec.run]!,
          kind: 'pull_request_state',
          status: spec.status,
          requestedAt: seconds(spec.requestedAt),
          ...(spec.status === 'claimed'
            ? { claimedBy: OTHER, claimedAt: seconds(spec.claimedAt ?? 0) }
            : {}),
          ...(spec.retryAt === undefined ? {} : { retryAt: seconds(spec.retryAt) }),
          ...(done ? { finishedAt: seconds(spec.requestedAt + 1) } : {}),
        },
        select: { id: true },
      });
      ids.push(created.id);
    }
    return ids;
  }

  async function views(): Promise<{ lookups: LookupHandOutView[]; runs: LookupRunView[] }> {
    const rows = await db().runLookup.findMany();
    const runs = await db().run.findMany({
      select: { id: true, pullRequestNumber: true, runBranch: true },
    });
    return {
      lookups: rows.map((row) => ({
        id: row.id,
        runId: row.runId,
        status: row.status as LookupHandOutView['status'],
        requestedAt: row.requestedAt,
        claimedAt: row.claimedAt,
        retryAt: row.retryAt,
      })),
      runs: runs.map((run) => ({
        id: run.id,
        hasPullRequest: run.pullRequestNumber !== null,
        hasRunBranch: run.runBranch !== null,
      })),
    };
  }

  const states = async () =>
    Object.fromEntries(
      (await db().runLookup.findMany()).map((row) => [
        row.id,
        `${row.status}/${row.claimedBy ?? '-'}/${row.claimedAt?.toISOString() ?? '-'}`,
      ]),
    );

  const BOTH: RunSpec = { pullRequest: true, branch: true };
  const SCENARIOS: Record<string, { runs: RunSpec[]; lookups: LookupSpec[] }> = {
    'oldest requests first, at most the limit': {
      runs: [BOTH, BOTH, BOTH, BOTH, BOTH],
      lookups: [
        { run: 0, status: 'requested', requestedAt: -10 },
        { run: 1, status: 'requested', requestedAt: -50 },
        { run: 2, status: 'requested', requestedAt: -30 },
        { run: 3, status: 'requested', requestedAt: -20 },
        { run: 4, status: 'requested', requestedAt: -40 },
      ],
    },
    'answered, failed and rate-limited requests are left alone': {
      runs: [BOTH, BOTH, BOTH, BOTH],
      lookups: [
        { run: 0, status: 'done', requestedAt: -100 },
        { run: 1, status: 'failed', requestedAt: -90 },
        { run: 2, status: 'requested', requestedAt: -80, retryAt: 60 },
        { run: 3, status: 'requested', requestedAt: -70, retryAt: -5 },
      ],
    },
    'a Run without a pull request or without a Run branch has nothing to look up': {
      runs: [{ pullRequest: false, branch: true }, { pullRequest: true, branch: false }, BOTH],
      lookups: [
        { run: 0, status: 'requested', requestedAt: -30 },
        { run: 1, status: 'requested', requestedAt: -20 },
        { run: 2, status: 'requested', requestedAt: -10 },
      ],
    },
    'a claim goes back to the queue at the age of the lease, not before': {
      runs: [BOTH, BOTH, BOTH],
      lookups: [
        { run: 0, status: 'claimed', requestedAt: -400, claimedAt: -LEASE_SECONDS },
        { run: 1, status: 'claimed', requestedAt: -300, claimedAt: -LEASE_SECONDS + 1 },
        { run: 2, status: 'claimed', requestedAt: -200, claimedAt: -LEASE_SECONDS - 60 },
      ],
    },
    'an expired claim of a Run without a pull request is back in the queue, not handed out': {
      runs: [{ pullRequest: false, branch: true }, BOTH],
      lookups: [
        { run: 0, status: 'claimed', requestedAt: -400, claimedAt: -LEASE_SECONDS - 1 },
        { run: 1, status: 'requested', requestedAt: -100 },
      ],
    },
  };

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(`hands out what the rule says: ${name}`, async () => {
      const ids = await fixtures(scenario.runs, scenario.lookups);
      const rule = LookupHandOutRule.at(NOW, { leaseSeconds: LEASE_SECONDS, limit: 3 });
      const read = await views();
      const expected = rule.next(read.lookups, read.runs).map((lookup) => lookup.id);
      const before = await states();

      const handed = await lookups().claim(WORKER, rule);

      expect(handed.map((lookup) => lookup.id)).toEqual(expected);
      const after = await states();
      for (const id of ids) {
        const lookup = read.lookups.find((candidate) => candidate.id === id)!;
        if (expected.includes(id)) {
          expect(after[id]).toBe(`claimed/${WORKER}/${NOW.toISOString()}`);
        } else if (rule.claimExpired(lookup)) {
          expect(after[id]).toBe('requested/-/-');
        } else {
          expect(after[id]).toBe(before[id]);
        }
      }
      const again = await views();
      expect((await lookups().claim(OTHER, rule)).map((lookup) => lookup.id)).toEqual(
        rule.next(again.lookups, again.runs).map((lookup) => lookup.id),
      );
    });
  }

  it('tells the worker what it needs to answer, from the Run', async () => {
    await fixtures([BOTH], [{ run: 0, status: 'requested', requestedAt: -10 }]);

    const [lookup] = await lookups().claim(WORKER, LookupHandOutRule.at(NOW));

    expect(lookup).toMatchObject({
      kind: 'pull_request_state',
      remoteUrl: 'https://git.example.test/acme/shop.git',
      pullRequestNumber: 7,
      runBranch: 'agent/x-r1',
      integrationBranch: 'dev',
    });
  });
});
