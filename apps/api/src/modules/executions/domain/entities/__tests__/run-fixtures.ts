import type { RunData } from '../../value-objects/run-data.js';
import { RunPullRequestStatus } from '../../value-objects/run-pull-request-status.js';

export const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
export const PROJECT_ID = '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b';
export const AT = new Date('2026-11-15T12:00:00.000Z');

/** A stored Run for the Run's unit tests, `waiting_for_operator` unless `overrides` say otherwise. */
export function runData(overrides: Partial<RunData> = {}): RunData {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    provider: 'codex',
    task: 'x',
    state: 'waiting_for_operator',
    startCommit: 'a',
    remoteUrl: 'https://git.example.test/a.git',
    workingCopy: null,
    integrationBranch: 'dev',
    delivery: null,
    pullRequest: null,
    deliveryRequested: false,
    failingChecks: [],
    createdAt: AT,
    startedAt: AT,
    finishedAt: null,
    failure: null,
    claimedBy: null,
    heartbeatAt: null,
    limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
    environmentFileSupplied: false,
    environmentFilePath: null,
    cancelRequestedAt: null,
    cancellation: null,
    waitingSince: AT,
    stepStartedAt: null,
    releasedBy: null,
    sessionRef: 'session-1',
    messages: [],
    lastClaimedBy: null,
    stepCount: 0,
    followUpCount: 0,
    followUpQueued: false,
    stepsBeforePart: 0,
    pushedCommit: null,
    workingCopyRemovedAt: null,
    pullRequestStatus: RunPullRequestStatus.none().toStored(),
    lastActivityAt: AT,
    ...overrides,
  };
}
