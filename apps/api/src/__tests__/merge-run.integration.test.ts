import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MergeCredential } from '../platform/config/merge-credential.js';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { problemDetailsSchema } from '../platform/http/problem-details.js';
import { WITHOUT_QUEUE_WORKERS } from './test-config.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';

// Approving and merging a Run's pull request from Studio over HTTP on the real app (PostgreSQL and
// Redis via Testcontainers), with a recording fake of the Git host and the worker's side driven
// over its routes.

// Throwaway credentials generated per run; none is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
const MERGE_TOKEN = randomBytes(24).toString('hex');
const WORKER = randomUUID();
const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
const LIMITS = { stepMinutes: 60, maxSteps: 5, waitingDays: 14, maxTotalSteps: 20 };
const COMMIT = 'c'.repeat(40);
const MERGED_COMMIT = 'e'.repeat(40);
const PROBLEM = (code: string) => `urn:agentic-studio:problem:merge-${code}`;

type FakeHost = NonNullable<
  NonNullable<NonNullable<Parameters<typeof startStudioApp>[1]>['executions']>['mergeHost']
>;
type HostCheck = { name: string; state: 'success' | 'failure' | 'pending' | 'neutral' };

/** A Git host with one pull request that records what it was asked and can refuse any call. */
function fakeHost() {
  const calls: string[] = [];
  const refusals = new Map<string, string>();
  const pullRequest = {
    state: 'open' as 'open' | 'closed' | 'merged',
    draft: true,
    headSha: COMMIT,
    mergeable: true as boolean | null,
    mergeableState: 'clean',
    mergedCommit: null as string | null,
  };
  const checks: { list: HostCheck[] } = { list: [] };
  const gate: { merge: Promise<void> | null } = { merge: null };
  const answer = (method: string) => {
    calls.push(method);
    const message = refusals.get(method);
    return message === undefined
      ? { ok: true as const }
      : { ok: false as const, failure: { code: 'refused' as const, message } };
  };
  const host = {
    readPullRequest: () => {
      calls.push('readPullRequest');
      return Promise.resolve({
        ok: true as const,
        pullRequest: {
          ...pullRequest,
          headRef: '',
          baseRef: 'dev',
          title: 'Add a health check',
          body: 'Adds GET /health.',
        },
      });
    },
    readChecks: () => {
      calls.push('readChecks');
      return Promise.resolve({ ok: true as const, checks: [...checks.list] });
    },
    markReady: () => {
      const result = answer('markReady');
      if (result.ok) pullRequest.draft = false;
      return Promise.resolve(result);
    },
    approve: () => Promise.resolve(answer('approve')),
    merge: async () => {
      const result = answer('merge');
      await gate.merge;
      if (!result.ok) return result;
      pullRequest.state = 'merged';
      pullRequest.mergedCommit = MERGED_COMMIT;
      return { ok: true as const, mergedCommit: MERGED_COMMIT };
    },
    close: () => Promise.reject(new Error('not used')),
    deleteRunBranch: () => Promise.resolve(answer('deleteRunBranch')),
  } satisfies FakeHost;
  return { host, calls, refusals, pullRequest, checks, gate };
}

describe('approve and merge API (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  let cookie: string;
  const git = fakeHost();

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const asWorker = (path: string, body: object) =>
    http().post(`/api/worker/${path}`).set('Authorization', `Bearer ${WORKER_TOKEN}`).send(body);
  const getRun = (runId: string) => http().get(`/api/runs/${runId}`).set('Cookie', cookie);
  const merge = (runId: string, body: object = { commit: COMMIT }, headers: object = {}) =>
    http()
      .post(`/api/runs/${runId}/merge`)
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie, ...headers })
      .send(body);

  function expectProblem(response: request.Response, status: number, type: string) {
    expect(response.status).toBe(status);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
    expect(response.body.type).toBe(type);
  }

  async function insertRepository(projectId: string) {
    const url = `https://github.com/acme/${projectId}.git`;
    await db().$executeRaw`
      INSERT INTO repositories
        (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at)
      VALUES (${projectId}::uuid, ${url}, ${url.slice(8, -4)}, 'dev', 'ready',
              ${randomBytes(20).toString('hex')}, now())`;
  }

  /** A Run of a new project carried to its draft pull request, with a ready merge review of COMMIT. */
  async function deliveredRun(options: { finish?: boolean; review?: boolean } = {}) {
    const name = `Shop ${randomUUID()}`;
    const [project] = await db().$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
      RETURNING id`;
    await insertRepository(project!.id);
    const started = await http()
      .post(`/api/projects/${project!.id}/runs`)
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
      .send({ task: 'Add a health check', provider: 'claude_code' });
    expect(started.status).toBe(201);
    const runId = started.body.id as string;
    expect((await asWorker('runs/claim', { workerId: WORKER })).status).toBe(200);
    await asWorker(`runs/${runId}/state`, { workerId: WORKER, state: 'running' });
    if (options.finish !== false) {
      const stepped = await asWorker(`runs/${runId}/steps`, {
        workerId: WORKER,
        index: 1,
        kind: 'start',
        result: { outcome: 'done', summary: 'Done.', sessionRef: 'session-1' },
        workingCopy: {
          runBranch: `agent/add-a-health-check-r${runId.slice(0, 8)}`,
          commits: [{ id: COMMIT, subject: 'Add GET /health' }],
          hasUncommittedChanges: false,
        },
      });
      expect(stepped.status).toBe(204);
      const ended = await asWorker(`runs/${runId}/state`, {
        workerId: WORKER,
        state: 'succeeded',
        delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
      });
      expect(ended.status).toBe(204);
    }
    if (options.review !== false) {
      await db().$executeRaw`
        INSERT INTO run_merge_reviews
          (run_id, state, run_commit, integration_commit, files, truncated, requested_at, completed_at)
        VALUES (${runId}::uuid, 'ready', ${COMMIT}, ${'a'.repeat(40)}, '[]'::jsonb, false, now(), now())`;
    }
    return { runId, projectId: project!.id };
  }

  const approvalRows = (runId: string) =>
    db().$queryRaw<{ result: string; refusal_code: string | null; merged_commit: string | null }[]>`
      SELECT result, refusal_code, merged_commit FROM merge_approvals
      WHERE run_id = ${runId}::uuid ORDER BY approved_at`;

  beforeAll(async () => {
    services = await startStudioServices();
    app = await startStudioApp(
      {
        ...services.config,
        workerToken: WORKER_TOKEN_DIGEST,
        runLimits: LIMITS,
        mergeCredential: MergeCredential.of(MERGE_TOKEN),
      },
      // No job worker: the Integration branch fetch is scheduled, never run against the network.
      { ...WITHOUT_QUEUE_WORKERS, executions: { mergeHost: git.host } },
    );
    cookie = await signIn(app);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
  });

  beforeEach(async () => {
    // Test isolation only; CASCADE also empties runs and their approvals.
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    git.calls.length = 0;
    git.refusals.clear();
    Object.assign(git.pullRequest, {
      state: 'open',
      draft: true,
      headSha: COMMIT,
      mergeable: true,
      mergeableState: 'clean',
      mergedCommit: null,
    });
    git.checks.list = [];
    git.gate.merge = null;
    // The worker reports itself with every poll: Runs can only start once it has.
    const status = await asWorker('status', {
      workerId: WORKER,
      runner: 'cli',
      providers: { claude_code: true, codex: true },
    });
    expect(status.status).toBe(204);
  });

  it('marks ready, approves and merges the approved commit, and the Run shows the approval and merged state', async () => {
    const { runId, projectId } = await deliveredRun();
    git.checks.list = [{ name: 'ci', state: 'success' }];

    const merged = await merge(runId);

    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({
      approvedBy: 'operator',
      commit: COMMIT,
      integrationBranch: 'dev',
      method: 'squash',
      checksSeen: [{ name: 'ci', state: 'success' }],
      result: 'carried_out',
      mergedCommit: MERGED_COMMIT,
      cloneFetchStartedAt: expect.any(String),
      runBranchDeletedAt: expect.any(String),
    });
    expect(git.calls).toEqual([
      'readPullRequest',
      'readChecks',
      'markReady',
      'approve',
      'merge',
      'deleteRunBranch',
    ]);
    const run = await getRun(runId);
    expect(run.body.pullRequest.state).toBe('merged');
    expect(run.body.pullRequest.runBranchDeletedAt).toBe(merged.body.runBranchDeletedAt);
    expect(run.body.latestMergeApproval).toEqual({
      id: merged.body.id,
      approvedAt: merged.body.approvedAt,
      approvedBy: 'operator',
      commit: COMMIT,
      integrationBranch: 'dev',
      method: 'squash',
      checksSeen: [{ name: 'ci', state: 'success' }],
      result: 'carried_out',
      mergedCommit: MERGED_COMMIT,
      completedAt: expect.any(String),
      cloneFetchStartedAt: merged.body.cloneFetchStartedAt,
    });
    const [repository] = await db().$queryRaw<{ state: string }[]>`
      SELECT state FROM repositories WHERE project_id = ${projectId}::uuid`;
    expect(repository!.state).toBe('fetching');
  });

  it('does not mark ready a pull request that is not a draft', async () => {
    const { runId } = await deliveredRun();
    git.pullRequest.draft = false;

    expect((await merge(runId)).status).toBe(200);

    expect(git.calls).not.toContain('markReady');
  });

  it('merges a commit that has no checks at all', async () => {
    const { runId } = await deliveredRun();

    const merged = await merge(runId);

    expect(merged.status).toBe(200);
    expect(merged.body.checksSeen).toEqual([]);
  });

  it('repeats a finished merge without any host call, answering the stored result', async () => {
    const { runId } = await deliveredRun();
    const first = await merge(runId);
    git.calls.length = 0;

    const again = await merge(runId);

    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(git.calls).toEqual([]);
    expect(await approvalRows(runId)).toHaveLength(1);
  });

  it('keeps the merge when the branch deletion fails, and the same request retries only that', async () => {
    const { runId } = await deliveredRun();
    git.refusals.set('deleteRunBranch', 'Branch is protected.');

    const first = await merge(runId);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      result: 'carried_out',
      runBranchDeletionFailure: 'Branch is protected.',
    });
    expect(first.body).not.toHaveProperty('runBranchDeletedAt');
    git.refusals.clear();
    git.calls.length = 0;

    const retried = await merge(runId);

    expect(git.calls).toEqual(['deleteRunBranch']);
    expect(retried.body).toHaveProperty('runBranchDeletedAt');
    expect(retried.body).not.toHaveProperty('runBranchDeletionFailure');
    expect(retried.body.id).toBe(first.body.id);
  });

  it('keeps the merge when the Clone fetch cannot start, and the same request starts it later', async () => {
    const { runId, projectId } = await deliveredRun();
    await db().$executeRaw`DELETE FROM repositories WHERE project_id = ${projectId}::uuid`;

    const first = await merge(runId);

    expect(first.status).toBe(200);
    expect(first.body.result).toBe('carried_out');
    expect(first.body).not.toHaveProperty('cloneFetchStartedAt');
    await insertRepository(projectId);
    git.calls.length = 0;

    const retried = await merge(runId);

    expect(git.calls).toEqual([]);
    expect(retried.body).toHaveProperty('cloneFetchStartedAt');
    const [repository] = await db().$queryRaw<{ state: string }[]>`
      SELECT state FROM repositories WHERE project_id = ${projectId}::uuid`;
    expect(repository!.state).toBe('fetching');
  });

  describe('refusals', () => {
    it('run_active: the Run is still working', async () => {
      const { runId } = await deliveredRun({ finish: false, review: false });

      expectProblem(await merge(runId), 409, PROBLEM('run-active'));
      expect(git.calls).toEqual([]);
    });

    it('review_out_of_date: no merge review was requested', async () => {
      const { runId } = await deliveredRun({ review: false });

      expectProblem(await merge(runId), 409, PROBLEM('review-out-of-date'));
      expect(git.calls).toEqual([]);
    });

    it('commit_moved: the request names another commit than the review', async () => {
      const { runId } = await deliveredRun();

      expectProblem(await merge(runId, { commit: 'd'.repeat(40) }), 409, PROBLEM('commit-moved'));
      expect(git.calls).toEqual([]);
      expect(await approvalRows(runId)).toEqual([]);
    });

    it('commit_moved: the head on the host is not the approved commit', async () => {
      const { runId } = await deliveredRun();
      git.pullRequest.headSha = 'd'.repeat(40);

      expectProblem(await merge(runId), 409, PROBLEM('commit-moved'));
      expect(git.calls).toEqual(['readPullRequest', 'readChecks']);
      expect(await approvalRows(runId)).toEqual([]);
    });

    it.each([
      ['checks-failing', [{ name: 'ci', state: 'failure' as const }], {}],
      ['checks-running', [{ name: 'ci', state: 'pending' as const }], {}],
      ['checks-running', [], { mergeable: null }],
      ['conflicting', [], { mergeable: false, mergeableState: 'dirty' }],
      ['pull-request-not-open', [], { state: 'merged' as const }],
    ])('%s: nothing is stored and nothing is written on the host', async (code, checks, change) => {
      const { runId } = await deliveredRun();
      git.checks.list = checks;
      Object.assign(git.pullRequest, change);

      expectProblem(await merge(runId), 409, PROBLEM(code));

      expect(git.calls).toEqual(['readPullRequest', 'readChecks']);
      expect(await approvalRows(runId)).toEqual([]);
    });

    it.each(['markReady', 'approve', 'merge'] as const)(
      'host_refused at %s: the approval is kept as not carried out, with the reason, and a new attempt can follow',
      async (step) => {
        const { runId } = await deliveredRun();
        git.refusals.set(step, 'Required status check is expected.');

        const refused = await merge(runId);

        expectProblem(refused, 409, PROBLEM('host-refused'));
        expect(refused.body.detail).toContain('Required status check is expected.');
        expect(await approvalRows(runId)).toEqual([
          { result: 'not_carried_out', refusal_code: 'host_refused', merged_commit: null },
        ]);
        expect((await getRun(runId)).body.latestMergeApproval).toMatchObject({
          result: 'not_carried_out',
          refusal: { code: 'host_refused', reason: 'Required status check is expected.' },
        });
        expect(git.calls).not.toContain('deleteRunBranch');
        git.refusals.clear();
        expect((await merge(runId)).status).toBe(200);
        expect((await approvalRows(runId)).map((row) => row.result)).toEqual([
          'not_carried_out',
          'carried_out',
        ]);
      },
    );

    it('a merge the host carried out although the record says otherwise is recorded by the next request', async () => {
      const { runId } = await deliveredRun();
      git.refusals.set('merge', 'GitHub could not be reached.');
      expectProblem(await merge(runId), 409, PROBLEM('host-refused'));
      git.refusals.clear();
      git.pullRequest.state = 'merged';
      git.pullRequest.mergedCommit = MERGED_COMMIT;
      git.calls.length = 0;

      const recorded = await merge(runId);

      expect(recorded.status).toBe(200);
      expect(recorded.body).toMatchObject({ result: 'carried_out', mergedCommit: MERGED_COMMIT });
      expect(git.calls).toEqual(['readPullRequest', 'deleteRunBranch']);
      expect(await approvalRows(runId)).toEqual([
        { result: 'carried_out', refusal_code: null, merged_commit: MERGED_COMMIT },
      ]);
      expect((await getRun(runId)).body.pullRequest.state).toBe('merged');
    });

    it('is a 404 for an unknown run and a 422 for a commit that is not a full commit id', async () => {
      const { runId } = await deliveredRun();

      expect((await merge(randomUUID())).status).toBe(404);
      for (const body of [{}, { commit: 'abc123' }, { commit: 'g'.repeat(40) }]) {
        expect((await merge(runId, body)).status).toBe(422);
      }
      expect(git.calls).toEqual([]);
    });
  });

  it('merges once when two requests arrive together: the second answers merge_in_progress', async () => {
    const { runId } = await deliveredRun();
    let release = () => undefined as void;
    git.gate.merge = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = merge(runId).then((response) => response);
    for (let waited = 0; !git.calls.includes('merge') && waited < 100; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(git.calls).toContain('merge');
    const second = await merge(runId);
    release();
    const done = await first;

    expectProblem(second, 409, PROBLEM('in-progress'));
    expect(done.status).toBe(200);
    expect(git.calls.filter((call) => call === 'merge')).toHaveLength(1);
    expect(await approvalRows(runId)).toHaveLength(1);
  });

  it('refuses a pending approval of a request that died only after its lease, then merges', async () => {
    const { runId } = await deliveredRun();
    await db().$executeRaw`
      INSERT INTO merge_approvals
        (run_id, approved_at, approved_by, "commit", integration_branch, method, checks_seen, result)
      VALUES (${runId}::uuid, now(), 'operator', ${COMMIT}, 'dev', 'squash', '[]'::jsonb, 'pending')`;

    expectProblem(await merge(runId), 409, PROBLEM('in-progress'));
    await db().$executeRaw`
      UPDATE merge_approvals SET approved_at = now() - interval '11 minutes'
      WHERE run_id = ${runId}::uuid`;

    expect((await merge(runId)).status).toBe(200);
    expect((await approvalRows(runId)).map((row) => row.refusal_code)).toEqual([
      'interrupted',
      null,
    ]);
  });

  it('is an operator route: no session, a foreign origin and the worker token are refused', async () => {
    const { runId } = await deliveredRun();

    expect((await merge(runId, { commit: COMMIT }, { Cookie: '' })).status).toBe(401);
    expect(
      (await merge(runId, { commit: COMMIT }, { Origin: 'https://evil.example' })).status,
    ).toBe(403);
    const withWorkerToken = await http()
      .post(`/api/runs/${runId}/merge`)
      .set({ Origin: STUDIO_ORIGIN, Authorization: `Bearer ${WORKER_TOKEN}` })
      .send({ commit: COMMIT });
    expect(withWorkerToken.status).toBe(401);
    expect(git.calls).toEqual([]);
    expect(await approvalRows(runId)).toEqual([]);
  });
});
