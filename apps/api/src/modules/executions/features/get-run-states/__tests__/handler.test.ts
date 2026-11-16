import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import type { RetentionPolicy } from '../../../ports/retention-policy.js';
import { GetRunStatesHandler } from '../handler.js';

// Issue #98: the agent worker asks which of its Runs are final, and since when, to apply the
// retention rules to their Working copies. Issue #143: Studio decides what the worker removes.
const POLICY: RetentionPolicy = {
  days: 7,
  maxPerProject: 10,
  openPullRequestIdleDays: 30,
  hoursAfterPullRequestEnd: 24,
};
const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;
const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OTHER_PROJECT = '4a3c9d2f-5e6b-4c7d-8e9f-0a1b2c3d4e5f';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const T1 = new Date('2026-11-15T12:30:00.000Z');

describe('GetRunStatesHandler', () => {
  let runs: InMemoryRunRepository;
  let handler: GetRunStatesHandler;

  const add = (projectId: string) =>
    runs.add({
      projectId,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
      integrationBranch: 'dev',
    });

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    handler = new GetRunStatesHandler(runs, { now: () => T1 }, POLICY);
  });

  it('answers the state of each asked Run, and when a final one finished', async () => {
    const finished = await add(PROJECT);
    const active = await add(OTHER_PROJECT);
    const queued = await add(PROJECT);
    await runs.claimNext(WORKER, T0);
    await runs.transitionClaimed({
      runId: finished.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'failed',
      failure: { code: 'preparation_failed', detail: 'x' },
      cancelRequested: false,
      now: T1,
    });
    await runs.claimNext(WORKER, T1);

    const states = await handler.execute([finished.id, active.id, queued.id]);

    expect(states).toEqual(
      expect.arrayContaining([
        {
          runId: finished.id,
          state: 'failed',
          finishedAt: T1,
          keepUntil: new Date(T1.getTime() + 7 * DAY),
        },
        { runId: active.id, state: 'preparing', finishedAt: null },
        { runId: queued.id, state: 'queued', finishedAt: null },
      ]),
    );
    expect(states).toHaveLength(3);
  });

  it('leaves out ids that name no Run', async () => {
    const run = await add(PROJECT);

    expect(await handler.execute([randomUUID(), run.id])).toEqual([
      { runId: run.id, state: 'queued', finishedAt: null },
    ]);
  });

  // Issue #141: the worker reports the Working copies its retention removed.
  it("records the removed Working copies of final Runs the reporting worker started, and no other's", async () => {
    const finished = await add(PROJECT);
    const active = await add(OTHER_PROJECT);
    await runs.claimNext(WORKER, T0);
    await runs.transitionClaimed({
      runId: finished.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'failed',
      failure: { code: 'preparation_failed', detail: 'x' },
      cancelRequested: false,
      now: T0,
    });
    await runs.claimNext(WORKER, T0);

    await handler.execute([finished.id], { workerId: randomUUID(), runIds: [finished.id] });
    expect((await runs.findById(finished.id))!.workingCopyRemovedAt).toBeNull();

    await handler.execute([finished.id], { workerId: WORKER, runIds: [finished.id, active.id] });
    expect((await runs.findById(finished.id))!.workingCopyRemovedAt).toEqual(T1);
    // A Run the worker is carrying keeps its Working copy, whatever is reported.
    expect((await runs.findById(active.id))!.workingCopyRemovedAt).toBeNull();
  });

  describe('what the worker does with a Working copy (Issue #143)', () => {
    const NOW = new Date('2026-12-01T12:00:00.000Z');
    const ago = (ms: number) => new Date(NOW.getTime() - ms);

    /** A final Run of `projectId`, finished `finishedAgo` before NOW, set up as given. */
    async function finished(
      projectId: string,
      finishedAgo: number,
      setup: {
        pullRequest?: boolean;
        prState?: 'draft' | 'open' | 'merged' | 'closed' | 'missing' | null;
        prEndedAgo?: number;
        state?: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
      } = {},
    ) {
      const created = await add(projectId);
      const run = runs.runs.find((candidate) => candidate.id === created.id)!;
      Object.assign(run, {
        state: setup.state ?? 'succeeded',
        workingCopy: { runBranch: 'agent/x', commits: [], hasUncommittedChanges: false },
        sessionRef: 'a1b2c3d4-0000-4000-8000-000000000001',
        finishedAt: ago(finishedAgo),
        lastActivityAt: ago(finishedAgo),
        ...(setup.pullRequest
          ? {
              delivery: 'delivered',
              pullRequest: { url: 'https://github.com/acme/shop/pull/7', number: 7 },
              pullRequestStatus: {
                ...run.pullRequestStatus,
                state: setup.prState ?? null,
                endedAt: setup.prEndedAgo === undefined ? null : ago(setup.prEndedAgo),
              },
            }
          : {}),
      });
      return created.id;
    }

    const asking = (policy: RetentionPolicy = POLICY) =>
      new GetRunStatesHandler(runs, { now: () => NOW }, policy);
    const answerFor = async (runId: string, policy?: RetentionPolicy) =>
      (await asking(policy).execute([runId])).find((answer) => answer.runId === runId);

    it('keeps a Run without a pull request seven days after it finished, then lets it go', async () => {
      const recent = await finished(PROJECT, 6 * DAY);
      const old = await finished(PROJECT, 8 * DAY);

      expect(await answerFor(recent)).toMatchObject({ keepUntil: new Date(NOW.getTime() + DAY) });
      expect(await answerFor(old)).toMatchObject({ removable: true });
      expect(await answerFor(old)).not.toHaveProperty('keepUntil');
    });

    it('keeps a Run with an open or draft pull request past seven days, until 30 days without activity', async () => {
      for (const prState of ['open', 'draft'] as const) {
        const run = await finished(PROJECT, 20 * DAY, { pullRequest: true, prState });
        expect(await answerFor(run)).toMatchObject({
          keepUntil: new Date(NOW.getTime() + 10 * DAY),
        });
      }
      const idle = await finished(PROJECT, 31 * DAY, { pullRequest: true, prState: 'open' });
      expect(await answerFor(idle)).toMatchObject({ removable: true });
    });

    it('lets a Run with a pull request go 24 hours after the pull request was merged or closed', async () => {
      for (const prState of ['merged', 'closed', 'missing'] as const) {
        const soon = await finished(PROJECT, 3 * DAY, {
          pullRequest: true,
          prState,
          prEndedAgo: 20 * HOUR,
        });
        expect(await answerFor(soon)).toMatchObject({
          keepUntil: new Date(NOW.getTime() + 4 * HOUR),
        });
        const over = await finished(PROJECT, 3 * DAY, {
          pullRequest: true,
          prState,
          prEndedAgo: 25 * HOUR,
        });
        expect(await answerFor(over)).toMatchObject({ removable: true });
      }
    });

    it('lets the idle limit win over a pull request that ended later', async () => {
      const run = await finished(PROJECT, 40 * DAY, {
        pullRequest: true,
        prState: 'merged',
        prEndedAgo: HOUR,
      });

      expect(await answerFor(run)).toMatchObject({ removable: true });
    });

    it('moves the date with activity on the Run', async () => {
      const run = await finished(PROJECT, 20 * DAY, { pullRequest: true, prState: 'open' });
      const before = (await answerFor(run))!.keepUntil!;

      runs.runs.find((candidate) => candidate.id === run)!.lastActivityAt = ago(DAY);

      expect((await answerFor(run))!.keepUntil!.getTime() - before.getTime()).toBe(19 * DAY);
    });

    it('treats a pull request of unknown state as open, however long the Git host was away', async () => {
      const run = await finished(PROJECT, 12 * DAY, { pullRequest: true, prState: null });

      expect(await answerFor(run)).toMatchObject({
        keepUntil: new Date(NOW.getTime() + 18 * DAY),
      });
    });

    it('never answers to remove a Run that is not final', async () => {
      const queued = await add(PROJECT);
      const waiting = await add(PROJECT);
      Object.assign(
        runs.runs.find((candidate) => candidate.id === waiting.id)!,
        {
          state: 'waiting_for_operator',
          lastActivityAt: ago(400 * DAY),
        },
      );

      for (const run of [queued, waiting]) {
        const answer = await answerFor(run.id);
        expect(answer).not.toHaveProperty('removable');
        expect(answer).not.toHaveProperty('keepUntil');
      }
    });

    it('removes beyond the newest ten Runs without a pull request of a Project, and never a Run with one', async () => {
      const withoutPullRequest: string[] = [];
      for (let n = 0; n < 12; n += 1) {
        withoutPullRequest.push(await finished(PROJECT, (n + 1) * HOUR));
      }
      const open = [
        await finished(PROJECT, 6 * HOUR, { pullRequest: true, prState: 'open' }),
        await finished(PROJECT, 7 * HOUR, { pullRequest: true, prState: 'open' }),
        await finished(PROJECT, 8 * HOUR, { pullRequest: true, prState: null }),
      ];
      const otherProject = await finished(OTHER_PROJECT, 13 * HOUR);

      // Asked in two batches: the limit still counts all of the Project's Runs.
      const answers = [
        ...(await asking().execute(withoutPullRequest.slice(0, 6))),
        ...(await asking().execute([...withoutPullRequest.slice(6), ...open, otherProject])),
      ];

      const removable = answers.filter((answer) => answer.removable).map((answer) => answer.runId);
      expect(removable.sort()).toEqual(withoutPullRequest.slice(10).sort());
      for (const run of open) {
        expect(answers.find((answer) => answer.runId === run)).toHaveProperty('keepUntil');
      }
      expect(answers.find((answer) => answer.runId === otherProject)).toHaveProperty('keepUntil');
    });

    it('does not count a Run that never had a Working copy toward the limit', async () => {
      const kept: string[] = [];
      for (let n = 0; n < 10; n += 1) kept.push(await finished(PROJECT, (n + 2) * HOUR));
      // Cancelled while queued, or refused before its clone: the newest, with no Working copy.
      for (let n = 0; n < 3; n += 1) {
        const never = await finished(PROJECT, n * HOUR + 1);
        runs.runs.find((candidate) => candidate.id === never)!.workingCopy = null;
        kept.push(never);
      }

      const answers = await asking().execute(kept);

      expect(answers.some((answer) => answer.removable)).toBe(false);
    });

    it('hands the agent session of a removable Run to the worker, and of no other', async () => {
      const old = await finished(PROJECT, 8 * DAY);
      const recent = await finished(PROJECT, DAY);

      expect(await answerFor(old)).toMatchObject({
        removable: true,
        session: { provider: 'codex', ref: 'a1b2c3d4-0000-4000-8000-000000000001' },
      });
      expect(await answerFor(recent)).not.toHaveProperty('session');
    });

    it('treats a merged pull request without a recorded end as open (a legacy row)', async () => {
      const run = await finished(PROJECT, 20 * DAY, { pullRequest: true, prState: 'merged' });

      expect(await answerFor(run)).toMatchObject({ keepUntil: expect.any(Date) });
    });

    it('does not count a Run whose Working copy was already removed toward the limit', async () => {
      const removed = await finished(PROJECT, HOUR);
      runs.runs.find((candidate) => candidate.id === removed)!.workingCopyRemovedAt = ago(HOUR);
      const kept: string[] = [];
      for (let n = 0; n < 10; n += 1) kept.push(await finished(PROJECT, (n + 2) * HOUR));

      const answers = await asking().execute(kept);

      expect(answers.some((answer) => answer.removable)).toBe(false);
    });

    it('takes the periods and the limit from the policy', async () => {
      const run = await finished(PROJECT, 2 * DAY);

      expect(await answerFor(run, { ...POLICY, days: 1 })).toMatchObject({ removable: true });
      expect(await answerFor(run, { ...POLICY, maxPerProject: 0 })).toMatchObject({
        removable: true,
      });
      expect(await answerFor(run, { ...POLICY, days: 3 })).toMatchObject({
        keepUntil: new Date(NOW.getTime() + DAY),
      });

      const withPullRequest = await finished(PROJECT, 5 * DAY, {
        pullRequest: true,
        prState: 'merged',
        prEndedAgo: 5 * HOUR,
      });
      expect(
        await answerFor(withPullRequest, { ...POLICY, hoursAfterPullRequestEnd: 1 }),
      ).toMatchObject({ removable: true });
      expect(
        await answerFor(withPullRequest, { ...POLICY, openPullRequestIdleDays: 4 }),
      ).toMatchObject({ removable: true });
    });
  });
});
