import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MergeApproval } from '../../../domain/entities/merge-approval.js';
import {
  MERGE_APPROVAL_REPOSITORY,
  type MergeApprovalRepository,
} from '../../../domain/repositories/merge-approval-repository.js';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../../platform/database/database.module.js';
import {
  startStudioApp,
  startStudioServices,
  type StudioServices,
} from '../../../../../__tests__/studio-test-app.js';

const T = new Date('2026-11-21T12:00:00.000Z');
type RunData = Parameters<DatabaseClient['run']['create']>[0]['data'];

describe('Merge approvals in the store (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const approvals = () => app.get<MergeApprovalRepository>(MERGE_APPROVAL_REPOSITORY);

  beforeAll(async () => {
    services = await startStudioServices();
    app = await startStudioApp(services.config);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
  });

  async function run(): Promise<string> {
    const name = `Shop ${randomUUID()}`;
    const [project] = await db().$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
      RETURNING id`;
    const created = await db().run.create({
      data: {
        projectId: project!.id,
        provider: 'codex',
        phases: {
          create: {
            position: 0,
            agentName: 'default-codex',
            agentSource: 'built_in',
            agentProvider: 'codex',
            agentModel: 'default',
            agentInstructions: '',
          },
        },
        task: 'Add a health check',
        startCommit: 'a'.repeat(40),
        remoteUrl: 'https://git.example.test/acme/shop.git',
        integrationBranch: 'dev',
        limitStepMinutes: 60,
        limitMaxSteps: 5,
        limitWaitingDays: 14,
        state: 'queued',
      } as RunData,
      select: { id: true },
    });
    return created.id;
  }

  const approval = (runId: string, at: Date = T) =>
    MergeApproval.approve(
      {
        id: randomUUID(),
        runId,
        commit: 'b'.repeat(40),
        integrationBranch: 'dev',
        method: 'squash',
        checksSeen: [{ name: 'ci', state: 'success' }],
      },
      at,
    );

  it('lets exactly one of many simultaneous pending approvals of a Run in', async () => {
    const runId = await run();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => approvals().add(approval(runId))),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const [count] = await db().$queryRaw<{ count: bigint }[]>`
      SELECT count(*) FROM merge_approvals WHERE run_id = ${runId}::uuid`;
    expect(Number(count!.count)).toBe(1);
  });

  it('lets a new approval in once the pending one has a result, and keeps every row', async () => {
    const runId = await run();
    const first = approval(runId);
    expect(await approvals().add(first)).toBe(true);
    expect(await approvals().add(approval(runId))).toBe(false);

    expect(await approvals().finish(first.notCarriedOut('host_refused', 'No.', T))).toBe(true);
    const second = approval(runId, new Date(T.getTime() + 1000));
    expect(await approvals().add(second)).toBe(true);

    expect((await approvals().findLatest(runId))?.id).toBe(second.id);
  });

  it('stores an outcome only while the approval is still pending', async () => {
    const runId = await run();
    const first = approval(runId);
    await approvals().add(first);
    expect(await approvals().finish(first.notCarriedOut('interrupted', 'Gone.', T))).toBe(true);

    expect(await approvals().finish(first.carriedOut('f'.repeat(40), T))).toBe(false);

    expect(await approvals().findLatest(runId)).toMatchObject({
      result: 'not_carried_out',
      mergedCommit: null,
    });
  });

  it('records the merge request only while the approval is pending, and keeps it through the outcome', async () => {
    const runId = await run();
    const first = approval(runId);
    await approvals().add(first);

    expect(await approvals().requestMerge(first.mergeRequested(T))).toBe(true);
    const unknown = first.mergeRequested(T).notCarriedOut('interrupted', 'Cut off.', T);
    expect(await approvals().finish(unknown)).toBe(true);

    expect((await approvals().findLatest(runId))?.mergeOutcomeUnknown).toBe(true);
    expect(await approvals().requestMerge(first.mergeRequested(new Date(T.getTime() + 1)))).toBe(
      false,
    );
  });

  it('keeps the commit, the checks seen and the fetch start through a round trip', async () => {
    const runId = await run();
    const first = approval(runId);
    await approvals().add(first);
    await approvals().finish(first.carriedOut('f'.repeat(40), T));
    await approvals().save(first.carriedOut('f'.repeat(40), T).cloneFetchStarted(T));

    expect(await approvals().findLatest(runId)).toMatchObject({
      commit: 'b'.repeat(40),
      checksSeen: [{ name: 'ci', state: 'success' }],
      result: 'carried_out',
      mergedCommit: 'f'.repeat(40),
      cloneFetchStartedAt: T,
    });
  });
});
