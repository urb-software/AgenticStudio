import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { InMemoryRunDiffRepository } from '../../../../domain/repositories/__tests__/in-memory-run-diff-repository.js';
import { InMemoryRunLog } from '../../../ports/__tests__/in-memory-run-log.js';
import { InMemorySecretStore } from '../../../ports/__tests__/in-memory-secret-store.js';
import { FakeProjectKinds } from '../../../ports/__tests__/fake-project-kinds.js';
import { SEQUENTIAL_PLANS } from '../../../ports/__tests__/fake-workflow-plans.js';
import {
  phaseAgent,
  WORKFLOW_COMMIT,
} from '../../../../domain/entities/__tests__/workflow-run-fixtures.js';
import { ClaimRunHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const WORKING_COPY = { runBranch: 'studio/run', commits: [], hasUncommittedChanges: true };

describe('the claims of a Workflow Run that sends work back', () => {
  let runs: InMemoryRunRepository;
  let handler: ClaimRunHandler;
  let runId: string;

  const start = (sendBacks?: number) =>
    runs.start({
      projectId: PROJECT,
      provider: 'codex',
      agent: phaseAgent('builder'),
      workflow: {
        record: {
          name: 'build-and-review',
          commit: WORKFLOW_COMMIT,
          items: [
            { id: 'build', kind: 'work', agent: 'builder' },
            { id: 'check', kind: 'review', agent: 'reviewer' },
          ],
          ...(sendBacks === undefined ? {} : { sendBacks }),
        },
        phaseAgents: [phaseAgent('builder'), phaseAgent('reviewer', 'claude_code')],
      },
      task: 'Add a health check',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 20 },
      integrationBranch: 'dev',
    });

  const done = (index: number, next: Parameters<typeof SEQUENTIAL_PLANS.next>[2] | 'rework') =>
    runs.change(runId, (run) => {
      run.reportState(WORKER, { state: 'running', failure: null }, T0);
      const review = run.currentPhaseView.kind === 'review';
      run.reportStep(
        WORKER,
        {
          kind: 'start',
          index,
          result: { outcome: 'done', summary: review ? 'Reviewed.' : 'Built.' },
          sessionRef: `s-${run.currentPhase}`,
          ...(review && next === 'changes_requested'
            ? {
                verdict: 'changes_requested' as const,
                findings: [{ text: 'Fix X.', file: 'a.ts' }],
              }
            : {}),
        },
        WORKING_COPY,
        [],
        T0,
        next === 'rework'
          ? { kind: 'phase', position: 1 }
          : next === 'changes_requested'
            ? SEQUENTIAL_PLANS.next(run.workflow!.toData(), run.currentPhase, 'changes_requested', {
                used: run.sendBacksUsed,
              })
            : { kind: 'phase', position: 1 },
      );
    });

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    const kinds = new FakeProjectKinds();
    kinds.definitionsId = null;
    handler = new ClaimRunHandler(
      kinds,
      runs,
      new InMemoryRunLog(runs),
      { now: () => T0 },
      { seconds: 60 },
      { forProject: () => Promise.resolve(null) },
      new InMemorySecretStore(),
      { releaseFor: () => Promise.resolve() },
      new InMemoryRunDiffRepository(),
      {
        describe: () => Promise.resolve({ status: 'found', skills: [] }),
        files: () => Promise.reject(new Error('not used')),
      },
      SEQUENTIAL_PLANS,
    );
  });

  /** Built, reviewed with changes requested, and the work sent back: the claim is next. */
  const sendBack = async (sendBacks?: number) => {
    runId = (await start(sendBacks)).id;
    await handler.execute({ workerId: WORKER });
    await done(1, 'done');
    await handler.execute({ workerId: WORKER });
    await done(2, 'changes_requested');
  };

  it('tells the review where the work goes back to, and that changes requested do not end the Workflow', async () => {
    runId = (await start()).id;
    await handler.execute({ workerId: WORKER });
    await done(1, 'done');

    const claimed = await handler.execute({ workerId: WORKER });

    expect(claimed?.phase).toMatchObject({
      kind: 'review',
      final: true,
      endsOnChangesRequested: false,
      sendBackTo: { itemId: 'build', round: 1, limit: 2 },
    });
  });

  it('says the review ends the Workflow on changes requested when the Workflow allows no send-back', async () => {
    runId = (await start(0)).id;
    await handler.execute({ workerId: WORKER });
    await done(1, 'done');

    const claimed = await handler.execute({ workerId: WORKER });

    expect(claimed?.phase).toMatchObject({ endsOnChangesRequested: true });
    expect(claimed?.phase).not.toHaveProperty('sendBackTo');
  });

  it('hands the work Phase its own session with the findings, as a claim of the send-back', async () => {
    await sendBack();

    const claimed = await handler.execute({ workerId: WORKER });

    expect(claimed).toMatchObject({
      state: 'preparing',
      provider: 'codex',
      agent: { name: 'builder' },
      handOut: {
        kind: 'next_phase',
        runBranch: 'studio/run',
        session: { sessionRef: 's-0', reason: 'send_back' },
      },
      stepsBeforePart: 2,
      phase: {
        position: 0,
        itemId: 'build',
        kind: 'work',
        final: false,
        sendBack: { round: 1, limit: 2, findings: [{ text: 'Fix X.', file: 'a.ts' }] },
      },
    });
    expect(claimed?.phase).not.toHaveProperty('previous');
  });

  it('hands the review its own session again after the work, with no findings to tell', async () => {
    await sendBack();
    await handler.execute({ workerId: WORKER });
    await done(3, 'rework');

    const claimed = await handler.execute({ workerId: WORKER });

    expect(claimed).toMatchObject({
      agent: { name: 'reviewer' },
      handOut: { kind: 'next_phase', session: { sessionRef: 's-1', reason: 'send_back' } },
      phase: {
        position: 1,
        kind: 'review',
        sendBack: { round: 1, limit: 2, findings: [] },
        previous: { itemId: 'build', summary: 'Built.' },
        endsOnChangesRequested: false,
        sendBackTo: { itemId: 'build', round: 2, limit: 2 },
      },
    });
  });

  it('says at the limit that changes requested end the Workflow', async () => {
    await sendBack(1);
    await handler.execute({ workerId: WORKER });
    await done(3, 'rework');

    const claimed = await handler.execute({ workerId: WORKER });

    expect(claimed?.phase).toMatchObject({ kind: 'review', endsOnChangesRequested: true });
    expect(claimed?.phase).not.toHaveProperty('sendBackTo');
  });

  it('cuts a finding to what the protocol carries', async () => {
    runId = (await start()).id;
    await handler.execute({ workerId: WORKER });
    await done(1, 'done');
    await handler.execute({ workerId: WORKER });
    await runs.change(runId, (run) => {
      run.reportState(WORKER, { state: 'running', failure: null }, T0);
      run.reportStep(
        WORKER,
        {
          kind: 'start',
          index: 2,
          result: { outcome: 'done', summary: 'Reviewed.' },
          sessionRef: 's-1',
          verdict: 'changes_requested',
          findings: [{ text: 'y'.repeat(2600), file: 'f'.repeat(600) }],
        },
        WORKING_COPY,
        [],
        T0,
        { kind: 'send_back', position: 0 },
      );
    });

    const claimed = await handler.execute({ workerId: WORKER });

    const [finding] = claimed!.phase!.sendBack!.findings;
    expect(finding!.text.length).toBeLessThanOrEqual(2000);
    expect(finding!.file!.length).toBeLessThanOrEqual(512);
  });
});
