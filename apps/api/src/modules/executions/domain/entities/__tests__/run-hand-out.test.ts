import { describe, expect, it } from 'vitest';
import { IllegalRunTransitionError } from '../../errors/run-errors.js';
import { Run } from '../run.js';
import type { RestoreData } from '../../../../../__tests__/restore-data.js';
import { AT, runData } from './run-fixtures.js';

const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const LATER = new Date('2026-11-20T12:00:00.000Z');
const WORKING_COPY = { runBranch: 'run/x', commits: [], hasUncommittedChanges: false };
const restored = (patch: Partial<RestoreData<typeof Run>>) => Run.restore(runData(patch));
const queued = (patch: Partial<RestoreData<typeof Run>> = {}) =>
  restored({ state: 'queued', startedAt: null, waitingSince: null, sessionRef: null, ...patch });

describe('Run.claimBy', () => {
  it('starts a queued Run for the worker and records what changed', () => {
    const run = queued({ followUpQueued: true });

    run.claimBy(WORKER, LATER);

    expect(run.lifecycle).toMatchObject({ state: 'preparing', startedAt: LATER });
    expect(run.pendingChanges().fields).toEqual({
      state: 'preparing',
      claimedBy: WORKER,
      lastClaimedBy: WORKER,
      startedAt: LATER,
      heartbeatAt: LATER,
      followUpQueued: false,
    });
  });

  it('keeps the first start of a resumed Run', () => {
    const run = queued({ startedAt: AT, sessionRef: 's', lastClaimedBy: WORKER });

    run.claimBy(WORKER, LATER);

    expect(run.lifecycle.startedAt).toEqual(AT);
  });

  it('only changes the holder of a failed Run kept for a delivery retry', () => {
    const run = restored({
      state: 'failed',
      failure: { code: 'delivery_failed', detail: 'x' },
      deliveryRequested: true,
      lastClaimedBy: WORKER,
      waitingSince: null,
    });

    run.claimBy(WORKER, LATER);

    expect(run.pendingChanges().fields).toEqual({ claimedBy: WORKER, heartbeatAt: LATER });
  });

  it('refuses a worker that may not take the Run', () => {
    const run = queued({ sessionRef: 's', lastClaimedBy: OTHER });

    expect(() => run.claimBy(WORKER, LATER)).toThrow(IllegalRunTransitionError);
    expect(run.pendingChanges().fields).toEqual({});
  });
});

describe('Run.handOut', () => {
  it('starts a queued Run with a remote', () => {
    expect(queued().handOut()).toEqual({ kind: 'start' });
  });

  it('refuses a queued Run whose repository was removed', () => {
    expect(queued({ remoteUrl: '' }).handOut()).toMatchObject({
      kind: 'refused',
      as: 'preparation',
      failure: { code: 'preparation_failed' },
    });
  });

  it('delivers a failed Run with a Working copy', () => {
    const run = restored({
      state: 'failed',
      failure: { code: 'delivery_failed', detail: 'x' },
      workingCopy: WORKING_COPY,
      pullRequest: { url: 'https://git.example.test/pr/4', number: 4 },
      waitingSince: null,
    });

    expect(run.handOut()).toEqual({
      kind: 'deliver',
      runBranch: 'run/x',
      pullRequestNumber: 4,
    });
  });

  it('refuses a delivery without a Working copy', () => {
    const run = restored({
      state: 'failed',
      failure: { code: 'delivery_failed', detail: 'x' },
      waitingSince: null,
    });

    expect(run.handOut()).toMatchObject({
      kind: 'refused',
      as: 'delivery',
      failure: { code: 'delivery_failed' },
    });
  });

  it('resumes a Run after an operator answer', () => {
    const run = queued({
      sessionRef: 'session-1',
      workingCopy: WORKING_COPY,
      messages: [
        { kind: 'question', question: { text: 'Which?' }, at: AT },
        { kind: 'answer', text: 'This one', at: AT },
      ],
    });

    expect(run.handOut()).toEqual({
      kind: 'resume',
      runBranch: 'run/x',
      sessionRef: 'session-1',
      answer: 'This one',
      reason: 'answer',
      newEnvironmentFile: false,
    });
  });

  it('refuses a resume whose Working copy the worker removed', () => {
    const run = queued({
      sessionRef: 'session-1',
      workingCopy: WORKING_COPY,
      workingCopyRemovedAt: AT,
      messages: [
        { kind: 'question', question: { text: 'Which?' }, at: AT },
        { kind: 'answer', text: 'This one', at: AT },
      ],
    });

    expect(run.handOut()).toMatchObject({
      kind: 'refused',
      as: 'preparation',
      failure: { detail: expect.stringContaining('retention removed it') },
    });
  });
});
