import { beforeEach, describe, expect, it } from 'vitest';
import {
  LOOKUP_CLAIM_MAX,
  LOOKUP_LEASE_SECONDS,
  type PullRequestStateResult,
} from '../../../domain/entities/run-lookup.js';
import { deliveredRun, T0, WORKER } from '../../../domain/repositories/__tests__/delivered-run.js';
import { InMemoryRunLookupRepository } from '../../../domain/repositories/__tests__/in-memory-run-lookup-repository.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { ClaimLookupsHandler } from '../../claim-lookups/handler.js';
import { LookupNotFoundError, LookupNotHeldError, ReportLookupResultHandler } from '../handler.js';

// Issue #142: a worker claims lookups and reports what it read.
const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const T1 = new Date(T0.getTime() + 5_000);

describe('lookups: claim and result', () => {
  let runs: InMemoryRunRepository;
  let lookups: InMemoryRunLookupRepository;
  let now: Date;
  let claims: ClaimLookupsHandler;
  let results: ReportLookupResultHandler;

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    lookups = new InMemoryRunLookupRepository(runs);
    now = T1;
    const clock = { now: () => now };
    claims = new ClaimLookupsHandler(lookups, clock);
    results = new ReportLookupResultHandler(lookups, clock);
  });

  /** A delivered Run with a lookup requested and claimed by `WORKER`. */
  async function claimed() {
    const run = await deliveredRun(runs);
    await lookups.request(run.id, 'pull_request_state', T0);
    const [lookup] = await claims.execute(WORKER);
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

  it('hands out nothing when no lookup waits, and each lookup to one worker only', async () => {
    expect(await claims.execute(WORKER)).toEqual([]);
    const { lookup } = await claimed();

    expect(lookup).toBeDefined();
    expect(await claims.execute(OTHER_WORKER)).toEqual([]);
  });

  it('hands out at most five lookups at a time', async () => {
    for (let index = 0; index < LOOKUP_CLAIM_MAX + 2; index++) {
      const run = await deliveredRun(runs);
      await lookups.request(run.id, 'pull_request_state', T0);
    }

    expect(await claims.execute(WORKER)).toHaveLength(LOOKUP_CLAIM_MAX);
    expect(await claims.execute(WORKER)).toHaveLength(2);
  });

  it('hands a claim its worker never answered to another one after the lease', async () => {
    await claimed();

    now = new Date(T1.getTime() + (LOOKUP_LEASE_SECONDS - 1) * 1000);
    expect(await claims.execute(OTHER_WORKER)).toEqual([]);
    now = new Date(T1.getTime() + LOOKUP_LEASE_SECONDS * 1000);
    expect(await claims.execute(OTHER_WORKER)).toHaveLength(1);
  });

  it.each<[string, PullRequestStateResult]>([
    ['draft', { state: 'draft', behindBy: 2, aheadBy: 3, mergeable: true }],
    ['open', { state: 'open', behindBy: 0, aheadBy: 1 }],
    ['merged', { state: 'merged' }],
    ['closed', { state: 'closed' }],
    ['missing', { state: 'missing' }],
  ])('stores a %s result on the Run and ends the refresh', async (_name, result) => {
    const { run, lookup } = await claimed();

    await results.execute(lookup.id, {
      workerId: WORKER,
      ok: true,
      kind: 'pull_request_state',
      result,
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
    });
  });

  it('keeps a repeated answer from changing anything', async () => {
    const { run, lookup } = await claimed();
    const answer = {
      workerId: WORKER,
      ok: true as const,
      kind: 'pull_request_state' as const,
      result: { state: 'open' as const },
    };
    await results.execute(lookup.id, answer);
    now = new Date(T1.getTime() + 60_000);

    await results.execute(lookup.id, answer);

    expect(status(run.id).refreshedAt).toEqual(T1);
  });

  it('keeps the last known state when a lookup fails, and says why', async () => {
    const { run, lookup } = await claimed();
    await results.execute(lookup.id, {
      workerId: WORKER,
      ok: true,
      kind: 'pull_request_state',
      result: { state: 'draft', behindBy: 1, aheadBy: 1 },
    });
    await lookups.request(run.id, 'pull_request_state', T1);
    const [second] = await claims.execute(WORKER);

    await results.execute(second!.id, {
      workerId: WORKER,
      ok: false,
      code: 'failed',
      error: 'GitHub could not be reached.',
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

    await results.execute(lookup.id, {
      workerId: WORKER,
      ok: false,
      code: 'rate_limited',
      error: 'GitHub asked to wait.',
      retryAfterSeconds: 300,
    });

    const retryAt = new Date(T1.getTime() + 300_000);
    expect(status(run.id)).toMatchObject({
      refreshError: 'GitHub asked to wait.',
      retryAt,
      refreshRequestedAt: T0,
    });
    // Not handed out before the time, then handed out again.
    expect(await claims.execute(WORKER)).toEqual([]);
    now = retryAt;
    expect(await claims.execute(OTHER_WORKER)).toHaveLength(1);
  });

  it('never waits longer than an hour for a rate limit', async () => {
    const { run, lookup } = await claimed();

    await results.execute(lookup.id, {
      workerId: WORKER,
      ok: false,
      code: 'rate_limited',
      error: 'GitHub asked to wait.',
      retryAfterSeconds: 86_400,
    });

    expect(status(run.id).retryAt).toEqual(new Date(T1.getTime() + 3_600_000));
  });

  it('does not retry a rejected lookup by itself', async () => {
    const { run, lookup } = await claimed();

    await results.execute(lookup.id, {
      workerId: WORKER,
      ok: false,
      code: 'scope_mismatch',
      error: 'Not the run pull request.',
    });

    expect(status(run.id).refreshRequestedAt).toBeNull();
    expect(lookups.lookups[0]?.status).toBe('failed');
    expect(await claims.execute(WORKER)).toEqual([]);
  });

  it('redacts token-shaped strings in a failure before storing it', async () => {
    const { run, lookup } = await claimed();
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

    await results.execute(lookup.id, {
      workerId: WORKER,
      ok: false,
      code: 'failed',
      error: `Refused: ${token}`,
    });

    expect(status(run.id).refreshError).not.toContain(token);
  });

  it('refuses an answer from a worker that does not hold the lookup', async () => {
    const { lookup } = await claimed();

    await expect(
      results.execute(lookup.id, {
        workerId: OTHER_WORKER,
        ok: true,
        kind: 'pull_request_state',
        result: { state: 'open' },
      }),
    ).rejects.toBeInstanceOf(LookupNotHeldError);
  });

  it('refuses an answer for an unknown lookup', async () => {
    await expect(
      results.execute('9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b', {
        workerId: WORKER,
        ok: false,
        code: 'failed',
        error: 'x',
      }),
    ).rejects.toBeInstanceOf(LookupNotFoundError);
  });
});
