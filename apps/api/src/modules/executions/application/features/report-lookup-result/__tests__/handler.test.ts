import { beforeEach, describe, expect, it } from 'vitest';
import {
  runResponseSchema,
  toRunListItem,
  toRunResponse,
} from '../../../../entry-points/http/shared/run-response.js';
import { runView } from '../../../run-view.js';
import { preparedFollowUpResponseSchema } from '../../../../entry-points/http/operator/get-prepared-follow-up/schema.js';
import { LookupHandOutRule } from '../../../../domain/value-objects/lookup-hand-out-rule.js';
import type { PullRequestStateResult } from '../../../../domain/value-objects/pull-request-state-result.js';
import {
  deliveredRun,
  PULL_REQUEST,
  T0,
  WORKER,
} from '../../../../domain/repositories/__tests__/delivered-run.js';
import type { InMemoryRunLookupRepository } from '../../../../domain/repositories/__tests__/in-memory-run-lookup-repository.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { inMemoryExecutions } from '../../../__tests__/in-memory-executions.js';
import { ClaimLookupsHandler } from '../../claim-lookups/handler.js';
import { LookupNotFoundError, LookupNotHeldError, ReportLookupResultHandler } from '../handler.js';
import { FakeProjectKinds } from '../../../ports/__tests__/fake-project-kinds.js';

const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const T1 = new Date(T0.getTime() + 5_000);

describe('lookups: claim and result', () => {
  let runs: InMemoryRunRepository;
  let lookups: InMemoryRunLookupRepository;
  let executions: ReturnType<typeof inMemoryExecutions>;
  let now: Date;
  let claims: ClaimLookupsHandler;
  const kinds = new FakeProjectKinds();
  let results: ReportLookupResultHandler;
  let known = ['hunter2-env-value'];
  const secrets = { forRun: () => Promise.resolve(known) };

  beforeEach(() => {
    known = ['hunter2-env-value'];
    kinds.definitionsId = null;
    runs = new InMemoryRunRepository();
    executions = inMemoryExecutions(runs);
    lookups = executions.lookups;
    now = T1;
    const clock = { now: () => now };
    claims = new ClaimLookupsHandler(kinds, lookups, clock);
    results = new ReportLookupResultHandler(lookups, clock, runs, secrets, executions.transactions);
  });

  async function claimed() {
    const run = await deliveredRun(runs);
    await executions.requests.request(run.id, 'pull_request_state', T0);
    const [lookup] = (await claims.execute({ workerId: WORKER })).lookups;
    return { run, lookup: lookup! };
  }

  const status = (runId: string) => runs.runs.find((run) => run.id === runId)!.pullRequestStatus;

  it('hands a worker what it needs to read the Run pull request, and nothing else', async () => {
    const { run, lookup } = await claimed();

    expect(lookup).toEqual({
      id: expect.any(String),
      kind: 'pull_request_state',
      runId: run.id,
      remoteUrl: 'https://github.com/acme/shop.git',
      pullRequestNumber: 7,
      runBranch: 'agent/x-r0b8e5c2d',
      integrationBranch: 'dev',
    });
  });

  it('never hands out the lookup of a Run of the definitions Project', async () => {
    const run = await deliveredRun(runs);
    await executions.requests.request(run.id, 'pull_request_state', T0);
    kinds.definitionsId = run.projectId;

    expect((await claims.execute({ workerId: WORKER })).lookups).toEqual([]);

    kinds.definitionsId = null;
    expect((await claims.execute({ workerId: WORKER })).lookups).toHaveLength(1);
  });

  it('hands out nothing when no lookup waits, and each lookup to one worker only', async () => {
    expect((await claims.execute({ workerId: WORKER })).lookups).toEqual([]);
    const { lookup } = await claimed();

    expect(lookup).toBeDefined();
    expect((await claims.execute({ workerId: OTHER_WORKER })).lookups).toEqual([]);
  });

  it('hands out at most five lookups at a time', async () => {
    for (let index = 0; index < LookupHandOutRule.CLAIM_MAX + 2; index++) {
      const run = await deliveredRun(runs);
      await executions.requests.request(run.id, 'pull_request_state', T0);
    }

    expect((await claims.execute({ workerId: WORKER })).lookups).toHaveLength(
      LookupHandOutRule.CLAIM_MAX,
    );
    expect((await claims.execute({ workerId: WORKER })).lookups).toHaveLength(2);
  });

  it('hands a claim its worker never answered to another one after the lease', async () => {
    await claimed();

    now = new Date(T1.getTime() + (LookupHandOutRule.LEASE_SECONDS - 1) * 1000);
    expect((await claims.execute({ workerId: OTHER_WORKER })).lookups).toEqual([]);
    now = new Date(T1.getTime() + LookupHandOutRule.LEASE_SECONDS * 1000);
    expect((await claims.execute({ workerId: OTHER_WORKER })).lookups).toHaveLength(1);
  });

  it.each<[string, PullRequestStateResult]>([
    ['draft', { state: 'draft', behindBy: 2, aheadBy: 3, mergeable: true }],
    ['open', { state: 'open', behindBy: 0, aheadBy: 1 }],
    ['merged', { state: 'merged' }],
    ['closed', { state: 'closed' }],
    ['missing', { state: 'missing' }],
  ])('stores a %s result on the Run and ends the refresh', async (_name, result) => {
    const { run, lookup } = await claimed();

    await results.execute({
      lookupId: lookup.id,
      answer: {
        workerId: WORKER,
        ok: true,
        kind: 'pull_request_state',
        result,
      },
    });

    expect(status(run.id)).toEqual({
      state: result.state,
      behindBy: result.behindBy ?? null,
      aheadBy: result.aheadBy ?? null,
      mergeable: result.mergeable ?? null,
      refreshedAt: T1,
      refreshError: null,
      retryAt: null,
      refreshRequestedAt: null,
      lastAttemptAt: T0,
      endedAt: ['merged', 'closed', 'missing'].includes(result.state) ? T1 : null,
      checks: null,
      prepareRequestedAt: null,
      prepareError: null,
      closeClaimedAt: null,
      closedFromStudioAt: null,
      runBranchDeletedAt: null,
      runBranchDeletionFailure: null,
    });
  });

  describe('Pull request checks', () => {
    const SHA = 'c'.repeat(40);
    const checks = [
      { name: 'build', state: 'passed' as const, durationSeconds: 61, url: 'https://ci.test/1' },
      { name: 'lint', state: 'failed' as const, url: 'https://ci.test/2' },
    ];

    it('stores the checks and their commit with the state, replacing the earlier ones', async () => {
      const { run, lookup } = await claimed();
      await results.execute({
        lookupId: lookup.id,
        answer: {
          workerId: WORKER,
          ok: true,
          kind: 'pull_request_state',
          result: { state: 'open', behindBy: 0, aheadBy: 1, checksCommit: SHA, checks },
        },
      });

      expect(status(run.id).checks).toEqual({ commit: SHA, checks });

      await executions.requests.request(run.id, 'pull_request_state', T1);
      const [second] = (await claims.execute({ workerId: WORKER })).lookups;
      await results.execute({
        lookupId: second!.id,
        answer: {
          workerId: WORKER,
          ok: true,
          kind: 'pull_request_state',
          result: { state: 'open', behindBy: 0, aheadBy: 1, checksCommit: SHA, checks: [] },
        },
      });

      expect(status(run.id).checks).toEqual({ commit: SHA, checks: [] });
    });

    it('stores that the Git host refused to tell the checks, dropping the old ones', async () => {
      const { run, lookup } = await claimed();
      await results.execute({
        lookupId: lookup.id,
        answer: {
          workerId: WORKER,
          ok: true,
          kind: 'pull_request_state',
          result: { state: 'open', checksUnavailable: true },
        },
      });

      expect(status(run.id).checks).toEqual({ unavailable: true });
    });

    it("masks the Run's known secrets and link credentials in a check's name and link", async () => {
      const { run, lookup } = await claimed();
      await results.execute({
        lookupId: lookup.id,
        answer: {
          workerId: WORKER,
          ok: true,
          kind: 'pull_request_state',
          result: {
            state: 'open',
            checksCommit: SHA,
            checks: [
              {
                name: 'deploy hunter2-env-value',
                state: 'failed',
                url: 'https://user:s3cr3t@ci.test/3',
              },
            ],
          },
        },
      });

      const stored = JSON.stringify(status(run.id).checks);
      expect(stored).not.toContain('hunter2-env-value');
      expect(stored).not.toContain('s3cr3t');
    });

    it('keeps a check link a link when a known secret value is part of it: the checks page instead', async () => {
      // An Environment file value that is part of the link's host would leave no address behind.
      known = ['github.com'];
      const { run, lookup } = await claimed();
      await results.execute({
        lookupId: lookup.id,
        answer: {
          workerId: WORKER,
          ok: true,
          kind: 'pull_request_state',
          result: {
            state: 'open',
            checksCommit: SHA,
            checks: [
              { name: 'build', state: 'failed', url: 'https://github.com/acme/shop/runs/1' },
            ],
          },
        },
      });

      const stored = status(run.id).checks;
      const url = stored && !stored.unavailable ? stored.checks[0]!.url : '';
      expect(url).toBe(`${PULL_REQUEST.url}/checks`);
      // The Run page and the lists can carry it: both responses still parse.
      const withStatus = runView((await runs.findById(run.id))!, { preparedFollowUp: false });
      expect(() => runResponseSchema.parse(toRunResponse(withStatus))).not.toThrow();
      expect(() => runResponseSchema.parse(toRunListItem(withStatus))).not.toThrow();
    });

    it('masks token-shaped strings in the name of a check', async () => {
      const { run, lookup } = await claimed();
      const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
      await results.execute({
        lookupId: lookup.id,
        answer: {
          workerId: WORKER,
          ok: true,
          kind: 'pull_request_state',
          result: {
            state: 'open',
            checksCommit: SHA,
            checks: [{ name: `deploy ${token}`, state: 'failed', url: 'https://ci.test/3' }],
          },
        },
      });

      const stored = status(run.id).checks;
      expect(JSON.stringify(stored)).not.toContain(token);
    });

    it('keeps no checks for a pull request that has ended', async () => {
      const { run, lookup } = await claimed();
      await results.execute({
        lookupId: lookup.id,
        answer: {
          workerId: WORKER,
          ok: true,
          kind: 'pull_request_state',
          result: { state: 'open', checksCommit: SHA, checks },
        },
      });
      await executions.requests.request(run.id, 'pull_request_state', T1);
      const [second] = (await claims.execute({ workerId: WORKER })).lookups;
      await results.execute({
        lookupId: second!.id,
        answer: {
          workerId: WORKER,
          ok: true,
          kind: 'pull_request_state',
          result: { state: 'merged' },
        },
      });

      expect(status(run.id).checks).toBeNull();
    });
  });

  describe('logs of failing checks', () => {
    const SHA = 'c'.repeat(40);
    const claimedLogs = async () => {
      const run = await deliveredRun(runs);
      await executions.requests.request(run.id, 'failing_check_logs', T0);
      const [lookup] = (await claims.execute({ workerId: WORKER })).lookups;
      return { run, lookup: lookup! };
    };
    const logsAnswer = {
      workerId: WORKER,
      ok: true as const,
      kind: 'failing_check_logs' as const,
      result: {
        commit: SHA,
        checks: [
          {
            name: 'unit tests',
            url: 'https://ci.test/1',
            logAvailable: true,
            excerpt: 'FAIL src/a.test.ts\nexpected 1 to be 2',
          },
          {
            name: 'deploy',
            url: 'https://ci.test/2',
            logAvailable: false,
            note: 'Log unavailable: the log has expired.',
          },
        ],
      },
    };

    it('hands the worker the same scope as a state lookup', async () => {
      const { run, lookup } = await claimedLogs();

      expect(lookup).toMatchObject({
        kind: 'failing_check_logs',
        runId: run.id,
        pullRequestNumber: 7,
      });
    });

    it('stores a prepared Follow-up for the operator, and sends nothing', async () => {
      const { run, lookup } = await claimedLogs();
      const before = runs.runs.find((candidate) => candidate.id === run.id)!;
      const messages = before.messages.length;

      await results.execute({ lookupId: lookup.id, answer: logsAnswer });

      const draft = runs.prepared.get(run.id)!;
      expect(draft.source).toBe('pull_request_checks');
      expect(draft.text).toContain('expected 1 to be 2');
      expect(draft.items.map((item) => item.name)).toEqual(['unit tests', 'deploy']);
      expect(runs.prepared.has(run.id)).toBe(true);
      expect(status(run.id)).toMatchObject({ prepareRequestedAt: null, prepareError: null });
      expect(before.messages).toHaveLength(messages);
      expect(before.followUpQueued).toBe(false);
      expect(before.state).not.toBe('queued');
    });

    it('replaces the earlier prepared Follow-up of the Run', async () => {
      const { run, lookup } = await claimedLogs();
      await results.execute({ lookupId: lookup.id, answer: logsAnswer });
      await executions.requests.request(run.id, 'failing_check_logs', T1);
      const [second] = (await claims.execute({ workerId: WORKER })).lookups;

      await results.execute({
        lookupId: second!.id,
        answer: {
          ...logsAnswer,
          result: { commit: SHA, checks: [logsAnswer.result.checks[1]!] },
        },
      });

      expect(runs.prepared.get(run.id)!.items).toHaveLength(1);
    });

    it("redacts the Run's known secret values and link credentials, in the log, names and links", async () => {
      const { run, lookup } = await claimedLogs();

      await results.execute({
        lookupId: lookup.id,
        answer: {
          ...logsAnswer,
          result: {
            commit: SHA,
            checks: [
              {
                name: 'deploy hunter2-env-value',
                url: 'https://user:s3cr3t@ci.test/job/1',
                logAvailable: true,
                excerpt: 'password is hunter2-env-value',
              },
            ],
          },
        },
      });

      const draft = runs.prepared.get(run.id)!;
      for (const leaked of ['hunter2-env-value', 's3cr3t']) {
        expect(draft.text).not.toContain(leaked);
        expect(JSON.stringify(draft.items)).not.toContain(leaked);
      }
    });

    it('keeps a prepared check link a link when a known secret value is part of it', async () => {
      known = ['github.com'];
      const { run, lookup } = await claimedLogs();

      await results.execute({
        lookupId: lookup.id,
        answer: {
          ...logsAnswer,
          result: {
            commit: SHA,
            checks: [
              {
                name: 'unit tests',
                url: 'https://github.com/acme/shop/runs/2',
                logAvailable: true,
                excerpt: 'failed',
              },
            ],
          },
        },
      });

      const draft = runs.prepared.get(run.id)!;
      expect(draft.items[0]!.url).toBe(`${PULL_REQUEST.url}/checks`);
      const response = {
        source: draft.source,
        text: draft.text,
        checks: draft.items,
      };
      expect(() => preparedFollowUpResponseSchema.parse(response)).not.toThrow();
    });

    it('redacts token-shaped strings in the log before storing it', async () => {
      const { run, lookup } = await claimedLogs();
      const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

      await results.execute({
        lookupId: lookup.id,
        answer: {
          ...logsAnswer,
          result: {
            commit: SHA,
            checks: [
              {
                name: 'unit tests',
                url: 'https://ci.test/1',
                logAvailable: true,
                excerpt: `export GITHUB_TOKEN=${token}\nerror`,
              },
            ],
          },
        },
      });

      expect(runs.prepared.get(run.id)!.text).not.toContain(token);
    });

    it('records why a preparation failed and leaves the pull request state alone', async () => {
      const { run, lookup } = await claimedLogs();
      await results.execute({
        lookupId: lookup.id,
        answer: {
          workerId: WORKER,
          ok: false,
          code: 'failed',
          error: 'The pull request is not open any more.',
        },
      });

      expect(status(run.id)).toMatchObject({
        prepareRequestedAt: null,
        prepareError: 'The pull request is not open any more.',
        refreshError: null,
      });
      expect(runs.prepared.has(run.id)).toBe(false);
    });

    it('keeps a rate-limited preparation preparing until its retry', async () => {
      const { run, lookup } = await claimedLogs();
      await results.execute({
        lookupId: lookup.id,
        answer: {
          workerId: WORKER,
          ok: false,
          code: 'rate_limited',
          error: 'GitHub asked to wait.',
          retryAfterSeconds: 60,
        },
      });

      expect(status(run.id)).toMatchObject({ prepareRequestedAt: T0, retryAt: null });
    });

    it('refuses a state answer for a logs lookup', async () => {
      const { lookup } = await claimedLogs();

      await expect(
        results.execute({
          lookupId: lookup.id,
          answer: {
            workerId: WORKER,
            ok: true,
            kind: 'pull_request_state',
            result: { state: 'open' },
          },
        }),
      ).rejects.toThrow("The answer is not of the lookup's kind.");
    });
  });

  it('keeps the first time the pull request was read as ended, and clears it when it is reopened', async () => {
    const { run, lookup } = await claimed();
    await results.execute({
      lookupId: lookup.id,
      answer: {
        workerId: WORKER,
        ok: true,
        kind: 'pull_request_state',
        result: { state: 'closed' },
      },
    });
    expect(status(run.id).endedAt).toEqual(T1);

    now = new Date(T1.getTime() + 3_600_000);
    await executions.requests.request(run.id, 'pull_request_state', now);
    const [again] = (await claims.execute({ workerId: WORKER })).lookups;
    await results.execute({
      lookupId: again!.id,
      answer: {
        workerId: WORKER,
        ok: true,
        kind: 'pull_request_state',
        result: { state: 'merged' },
      },
    });
    expect(status(run.id)).toMatchObject({ state: 'merged', endedAt: T1 });

    const later = new Date(T1.getTime() + 7_200_000);
    now = later;
    await executions.requests.request(run.id, 'pull_request_state', now);
    const [reopened] = (await claims.execute({ workerId: WORKER })).lookups;
    await results.execute({
      lookupId: reopened!.id,
      answer: {
        workerId: WORKER,
        ok: true,
        kind: 'pull_request_state',
        result: { state: 'open', behindBy: 0, aheadBy: 1 },
      },
    });
    expect(status(run.id).endedAt).toBeNull();
  });

  it('keeps a repeated answer from changing anything', async () => {
    const { run, lookup } = await claimed();
    const answer = {
      workerId: WORKER,
      ok: true as const,
      kind: 'pull_request_state' as const,
      result: { state: 'open' as const },
    };
    await results.execute({ lookupId: lookup.id, answer });
    now = new Date(T1.getTime() + 60_000);

    await results.execute({ lookupId: lookup.id, answer });

    expect(status(run.id).refreshedAt).toEqual(T1);
  });

  it('keeps the last known state when a lookup fails, and says why', async () => {
    const { run, lookup } = await claimed();
    await results.execute({
      lookupId: lookup.id,
      answer: {
        workerId: WORKER,
        ok: true,
        kind: 'pull_request_state',
        result: { state: 'draft', behindBy: 1, aheadBy: 1 },
      },
    });
    await executions.requests.request(run.id, 'pull_request_state', T1);
    const [second] = (await claims.execute({ workerId: WORKER })).lookups;

    await results.execute({
      lookupId: second!.id,
      answer: {
        workerId: WORKER,
        ok: false,
        code: 'failed',
        error: 'GitHub could not be reached.',
      },
    });

    expect(status(run.id)).toMatchObject({
      state: 'draft',
      behindBy: 1,
      refreshedAt: T1,
      refreshError: 'GitHub could not be reached.',
      retryAt: null,
      refreshRequestedAt: null,
    });
  });

  it('records a rate limit, keeps the lookup for later and says when', async () => {
    const { run, lookup } = await claimed();

    await results.execute({
      lookupId: lookup.id,
      answer: {
        workerId: WORKER,
        ok: false,
        code: 'rate_limited',
        error: 'GitHub asked to wait.',
        retryAfterSeconds: 300,
      },
    });

    const retryAt = new Date(T1.getTime() + 300_000);
    expect(status(run.id)).toMatchObject({
      refreshError: 'GitHub asked to wait.',
      retryAt,
      refreshRequestedAt: T0,
    });
    expect((await claims.execute({ workerId: WORKER })).lookups).toEqual([]);
    now = retryAt;
    expect((await claims.execute({ workerId: OTHER_WORKER })).lookups).toHaveLength(1);
  });

  it('never waits longer than an hour for a rate limit', async () => {
    const { run, lookup } = await claimed();

    await results.execute({
      lookupId: lookup.id,
      answer: {
        workerId: WORKER,
        ok: false,
        code: 'rate_limited',
        error: 'GitHub asked to wait.',
        retryAfterSeconds: 86_400,
      },
    });

    expect(status(run.id).retryAt).toEqual(new Date(T1.getTime() + 3_600_000));
  });

  it('does not retry a rejected lookup by itself', async () => {
    const { run, lookup } = await claimed();

    await results.execute({
      lookupId: lookup.id,
      answer: {
        workerId: WORKER,
        ok: false,
        code: 'scope_mismatch',
        error: 'Not the run pull request.',
      },
    });

    expect(status(run.id).refreshRequestedAt).toBeNull();
    expect(lookups.lookups[0]?.status).toBe('failed');
    expect((await claims.execute({ workerId: WORKER })).lookups).toEqual([]);
  });

  it('redacts token-shaped strings in a failure before storing it', async () => {
    const { run, lookup } = await claimed();
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

    await results.execute({
      lookupId: lookup.id,
      answer: {
        workerId: WORKER,
        ok: false,
        code: 'failed',
        error: `Refused: ${token}`,
      },
    });

    expect(status(run.id).refreshError).not.toContain(token);
  });

  it('refuses an answer from a worker that does not hold the lookup', async () => {
    const { lookup } = await claimed();

    await expect(
      results.execute({
        lookupId: lookup.id,
        answer: {
          workerId: OTHER_WORKER,
          ok: true,
          kind: 'pull_request_state',
          result: { state: 'open' },
        },
      }),
    ).rejects.toBeInstanceOf(LookupNotHeldError);
  });

  it('refuses an answer for an unknown lookup', async () => {
    await expect(
      results.execute({
        lookupId: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
        answer: {
          workerId: WORKER,
          ok: false,
          code: 'failed',
          error: 'x',
        },
      }),
    ).rejects.toBeInstanceOf(LookupNotFoundError);
  });
});
